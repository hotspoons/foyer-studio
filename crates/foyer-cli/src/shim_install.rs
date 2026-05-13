// Ardour shim preflight + install.
//
// The Foyer release binary embeds `shims/ardour/build/libfoyer_shim.so`
// as a `&'static [u8]` blob via `build.rs`. At `foyer serve` time when
// the active backend is Ardour, we:
//
//   1. Look up the Ardour executable (config override → PATH probe →
//      hard error with a helpful message).
//   2. Materialize the embedded shim into the user's Ardour surfaces
//      directory if it's missing or the hash differs from the blob
//      we ship. Idempotent — repeated runs no-op once the file is
//      already current.
//   3. (Optionally) warn when the installed Ardour's reported version
//      doesn't match what the embedded shim was built against (the
//      `FOYER_ARDOUR_VERSION` build-time constant).
//
// License framing: the .so blob lives inside the Rust binary as data,
// not as a linked library. The Rust binary never dlopens the shim —
// Ardour does, in its own process, where it's free to link against
// libardour as GPL code. The composition is layered (Rust sidecar +
// Ardour-with-shim talking over a Unix socket), the way a Linux
// distro composes GPL programs with the rest of userspace.

use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

/// The embedded shim bytes. Empty (`SHIM_PRESENT == false`) on dev
/// builds that lack a built shim — useful for working on the sidecar
/// without rebuilding the C++ surface every time. Production /
/// release builds always have a real blob.
pub const SHIM_BYTES: &[u8] = include_bytes!(env!("FOYER_BUNDLED_SHIM_PATH"));

/// Is a real shim embedded in this binary? Determined at build time
/// by `build.rs` based on whether the source `.so` existed.
pub const SHIM_PRESENT: bool = !matches!(env!("FOYER_BUNDLED_SHIM_PRESENT").as_bytes(), b"0");

/// Hash stamp of the embedded shim (FNV-1a over the bytes). The
/// installed copy at `surfaces/libfoyer_shim.so` stores a sibling
/// `.stamp` file so the next boot can compare and only re-write on
/// upgrade.
pub const SHIM_STAMP: &str = env!("FOYER_BUNDLED_SHIM_STAMP");

/// Ardour version the embedded shim was built against. The shim's
/// ABI is tied to a specific libardour, so loading mismatched
/// versions can crash. We report this on preflight and refuse to
/// install when the installed Ardour reports a clearly different
/// major.minor (older or newer). Override via build-time
/// `FOYER_ARDOUR_VERSION=…` if you've rebuilt the shim yourself.
pub const ARDOUR_VERSION: &str = env!("FOYER_ARDOUR_VERSION");

/// Outcome of `ensure_ardour_ready`. The CLI prints an `Err` with a
/// formatted message and exits non-zero; an `Ok` returns the binary
/// path the caller should spawn (Ardour itself), plus the surfaces-
/// dir path where the shim now lives.
#[derive(Debug, Clone)]
pub struct AardourReady {
    pub binary: PathBuf,
    pub shim_installed_at: PathBuf,
}

/// Preflight a `foyer serve --backend ardour` launch. Resolves the
/// Ardour binary (config override wins, then PATH, then a small list
/// of well-known paths), installs the embedded shim into the user's
/// surfaces directory if missing/outdated, and returns the
/// installed locations. The caller takes the binary path verbatim
/// when spawning Ardour later.
///
/// `ardour_binary_override` mirrors a `--ardour-path` CLI flag /
/// `ardour.binary` config entry; pass `None` to fall back to PATH.
pub fn ensure_ardour_ready(ardour_binary_override: Option<&Path>) -> Result<AardourReady> {
    if !SHIM_PRESENT {
        return Err(anyhow!(
            "this Foyer build has no embedded Ardour shim — \
             build with `FOYER_BUNDLED_SHIM=/path/to/libfoyer_shim.so` set, \
             or pass `--backend stub` to skip the Ardour requirement"
        ));
    }
    let binary = resolve_ardour_binary(ardour_binary_override)
        .context("Ardour executable not found on this system")?;
    check_version_compat(&binary);
    let shim_installed_at = install_shim_if_stale()
        .context("failed to install embedded Ardour shim")?;
    Ok(AardourReady {
        binary,
        shim_installed_at,
    })
}

/// Best-effort lookup of the Ardour binary. Order of preference:
///   1. Explicit override (`--ardour-path` / `ardour.binary` config).
///   2. `$PATH` probe for the version-stamped name we expect
///      (`ardour9`, `ardour9.0`, …) then the bare `ardour`.
///   3. A handful of well-known install locations (Debian/Ubuntu's
///      `/usr/bin/ardour9`, the binary tarball at
///      `/opt/Ardour-9*/bin/ardour9`, macOS `/Applications/…`).
fn resolve_ardour_binary(override_path: Option<&Path>) -> Result<PathBuf> {
    if let Some(p) = override_path {
        if !p.is_file() {
            return Err(anyhow!(
                "ardour binary not found at the configured path: {}",
                p.display()
            ));
        }
        return Ok(p.to_path_buf());
    }
    let major = ARDOUR_VERSION.split('.').next().unwrap_or("9");
    let candidates: &[&str] = &[
        &format!("ardour{major}"),
        "ardour",
        &format!("Ardour{major}"),
    ];
    for name in candidates {
        if let Some(p) = which(name) {
            return Ok(p);
        }
    }
    let absolute_candidates = [
        PathBuf::from(format!("/usr/bin/ardour{major}")),
        PathBuf::from(format!("/usr/local/bin/ardour{major}")),
        PathBuf::from(format!("/opt/Ardour-{ARDOUR_VERSION}/bin/ardour{major}")),
        // macOS app bundle. Foyer drives Ardour's CLI surface, not
        // the .app, but the inner executable works.
        PathBuf::from(format!(
            "/Applications/Ardour{major}.app/Contents/MacOS/Ardour{major}"
        )),
    ];
    for p in absolute_candidates {
        if p.is_file() {
            return Ok(p);
        }
    }
    Err(anyhow!(
        "could not find an Ardour {ARDOUR_VERSION} executable.\n\
         · install Ardour from https://ardour.org/ (Debian/Ubuntu: `apt install ardour`)\n\
         · or set `ardour.binary` in your config.yaml / pass `--ardour-path <bin>`\n\
         · or run without Ardour by passing `--backend stub`"
    ))
}

/// `which`-style lookup over `$PATH`. We avoid pulling in the `which`
/// crate; a few hundred bytes of stdlib code do the same job and keep
/// the dep graph small for musl builds.
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

/// Spawn `ardour --version` and warn (but don't fail) on a
/// major.minor mismatch against the embedded shim. Ardour 9.x's
/// libardour ABI is loosely stable across patch versions, so a
/// `9.2 vs 9.2.1` skew is fine but `9.2 vs 10.x` is asking for a
/// segfault. The actual install proceeds either way — the user
/// chose this Ardour, and we shouldn't second-guess; just log it.
fn check_version_compat(binary: &Path) {
    let out = Command::new(binary).arg("--version").output();
    let stdout = match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        _ => return,
    };
    // Lines look like `ardour9 9.2.0` or `Ardour 9.2`. Extract the
    // first version-shaped token and compare on major.minor.
    let installed = stdout
        .split_whitespace()
        .find(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit()) && t.contains('.'));
    let Some(installed) = installed else { return };
    let installed_mm = major_minor(installed);
    let expected_mm = major_minor(ARDOUR_VERSION);
    if installed_mm != expected_mm {
        tracing::warn!(
            "Ardour version mismatch: installed `{installed}` but Foyer's embedded \
             shim was built against `{ARDOUR_VERSION}`. The surfaces ABI is sensitive \
             to libardour version; if Ardour crashes on connect, rebuild the shim \
             against your installed version (see shims/ardour/README.md)."
        );
    }
}

fn major_minor(v: &str) -> (u32, u32) {
    let mut parts = v.split(|c: char| c == '.' || c == '-');
    let major = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (major, minor)
}

/// Materialize `SHIM_BYTES` into the user's Ardour surfaces dir if
/// it's missing or stale. Returns the path the file ended up at.
/// "Stale" = the sibling `.stamp` file's contents don't match
/// `SHIM_STAMP`, so an upgraded Foyer overwrites yesterday's shim
/// without the user knowing. Permission errors propagate.
fn install_shim_if_stale() -> Result<PathBuf> {
    let surfaces = ardour_surfaces_dir()?;
    std::fs::create_dir_all(&surfaces)
        .with_context(|| format!("create surfaces dir {}", surfaces.display()))?;
    let shim_name = format!("libfoyer_shim{}", shim_extension());
    let shim_path = surfaces.join(&shim_name);
    let stamp_path = surfaces.join(format!("{shim_name}.stamp"));
    let installed_stamp = std::fs::read_to_string(&stamp_path).unwrap_or_default();
    if shim_path.is_file() && installed_stamp.trim() == SHIM_STAMP {
        // Already current. Idempotent fast path.
        return Ok(shim_path);
    }
    std::fs::write(&shim_path, SHIM_BYTES)
        .with_context(|| format!("write shim to {}", shim_path.display()))?;
    std::fs::write(&stamp_path, SHIM_STAMP)
        .with_context(|| format!("write stamp to {}", stamp_path.display()))?;
    tracing::info!(
        "installed embedded Ardour shim ({} bytes) at {}",
        SHIM_BYTES.len(),
        shim_path.display()
    );
    Ok(shim_path)
}

/// Ardour surfaces directory for the current user. Linux uses
/// `$XDG_CONFIG_HOME/ardour{N}/surfaces`; macOS uses Ardour's
/// preferences folder under `~/Library/Preferences`. We key the
/// folder name on the major version so multiple Ardour installs can
/// coexist without colliding.
fn ardour_surfaces_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("could not determine $HOME"))?;
    let major = ARDOUR_VERSION.split('.').next().unwrap_or("9");
    let dir = if cfg!(target_os = "macos") {
        home.join("Library/Preferences").join(format!("Ardour{major}")).join("surfaces")
    } else {
        let xdg = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        xdg.join(format!("ardour{major}")).join("surfaces")
    };
    Ok(dir)
}

fn shim_extension() -> &'static str {
    if cfg!(target_os = "macos") {
        ".dylib"
    } else {
        ".so"
    }
}
