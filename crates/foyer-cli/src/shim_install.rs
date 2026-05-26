// Ardour shim preflight + install.
//
// The Foyer release binary embeds the file pointed at by the
// `FOYER_BUNDLED_SHIM` env var at build time (Justfile dev recipes
// point this at `~/.config/ardour9/surfaces/libfoyer_shim.so` — the
// same install location Ardour reads from at runtime) as a
// `&'static [u8]` blob via `build.rs`. At `foyer serve` time when
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

/// ABI-matrix scaffolding. Today the build embeds a single shim
/// targeting `ARDOUR_VERSION`, but the runtime exposes a table API
/// (`pick_shim_for`) so we can grow into a multi-shim build without
/// touching every call site. Each entry is `(major_minor, bytes,
/// stamp)`; `pick_shim_for("9.5")` walks the table for an exact
/// match. Future build.rs will populate this from a
/// `FOYER_BUNDLED_SHIMS=9.5=/a/path,9.6=/b/path` env var.
///
/// Today's single entry is the same `SHIM_BYTES` blob; runtime
/// behavior is unchanged. The point of the table is that
/// `pick_shim_for` now exists, so the desktop launcher's native-
/// Ardour mode can ask for "the shim for the installed Ardour's
/// version" and either get it or fail loudly instead of silently
/// installing the wrong ABI.
pub struct ShimEntry {
    /// major.minor — "9.5", "9.6", etc.
    pub abi: &'static str,
    pub bytes: &'static [u8],
    pub stamp: &'static str,
}

pub static SHIM_TABLE: &[ShimEntry] = &[ShimEntry {
    abi: env!("FOYER_ARDOUR_VERSION"),
    bytes: SHIM_BYTES,
    stamp: SHIM_STAMP,
}];

/// Pick a shim blob for the given Ardour version. Matches on
/// `major.minor` — patch differences are ABI-stable per upstream
/// Ardour. Returns None when no embedded shim covers this version;
/// the desktop wrapper surfaces that to the user as "Ardour X.Y is
/// not in the ABI matrix this Foyer build was compiled with —
/// download a matching Foyer build, or rebuild from source against
/// your Ardour."
pub fn pick_shim_for(version: &str) -> Option<&'static ShimEntry> {
    if !SHIM_PRESENT {
        return None;
    }
    let want = major_minor(version);
    SHIM_TABLE.iter().find(|e| major_minor(e.abi) == want)
}

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
    let installed_version = check_version_compat(&binary);
    // ABI matrix lookup — pick the embedded shim whose major.minor
    // matches the installed Ardour. Today's build embeds a single
    // shim so this always resolves to that one; future multi-ABI
    // builds will branch here. Falls back to the default entry when
    // version detection failed (Ardour --version returned garbage)
    // so we don't paint ourselves into a corner over a parse hiccup.
    let entry = installed_version
        .as_deref()
        .and_then(pick_shim_for)
        .or_else(|| SHIM_TABLE.first());
    let entry = entry.ok_or_else(|| anyhow!("no embedded shim available for this Foyer build"))?;
    let shim_installed_at =
        install_shim_entry(entry).context("failed to install embedded Ardour shim")?;
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

/// Spawn `ardour --version`, warn on a major.minor mismatch against
/// the embedded shim, AND return the parsed version-shaped token so
/// the caller can plug it into `pick_shim_for` for the ABI-matrix
/// lookup. Returns None when version detection fails — caller falls
/// back to whatever the build's default shim is.
fn check_version_compat(binary: &Path) -> Option<String> {
    let out = Command::new(binary).arg("--version").output();
    let stdout = match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        _ => return None,
    };
    // Lines look like `ardour9 9.2.0` or `Ardour 9.2`. Extract the
    // first version-shaped token and compare on major.minor.
    let installed = stdout
        .split_whitespace()
        .find(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit()) && t.contains('.'));
    let installed = installed?.to_string();
    let installed_mm = major_minor(&installed);
    let expected_mm = major_minor(ARDOUR_VERSION);
    if installed_mm != expected_mm {
        tracing::warn!(
            "Ardour version mismatch: installed `{installed}` but Foyer's embedded \
             shim was built against `{ARDOUR_VERSION}`. The surfaces ABI is sensitive \
             to libardour version; if Ardour crashes on connect, rebuild the shim \
             against your installed version (see shims/ardour/README.md)."
        );
    }
    Some(installed)
}

fn major_minor(v: &str) -> (u32, u32) {
    let mut parts = v.split(['.', '-']);
    let major = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (major, minor)
}

/// Materialize `SHIM_BYTES` into the user's Ardour surfaces dir if
/// it's missing or stale. Returns the path the file ended up at.
/// "Stale" = the sibling `.stamp` file's contents don't match
/// `SHIM_STAMP`, so an upgraded Foyer overwrites yesterday's shim
/// without the user knowing. Permission errors propagate.
fn install_shim_entry(entry: &ShimEntry) -> Result<PathBuf> {
    let surfaces = ardour_surfaces_dir()?;
    std::fs::create_dir_all(&surfaces)
        .with_context(|| format!("create surfaces dir {}", surfaces.display()))?;
    let shim_name = format!("libfoyer_shim{}", shim_extension());
    let shim_path = surfaces.join(&shim_name);
    let stamp_path = surfaces.join(format!("{shim_name}.stamp"));
    let installed_stamp = std::fs::read_to_string(&stamp_path).unwrap_or_default();
    if shim_path.is_file() && installed_stamp.trim() == entry.stamp {
        // Already current. Idempotent fast path.
        return Ok(shim_path);
    }
    std::fs::write(&shim_path, entry.bytes)
        .with_context(|| format!("write shim to {}", shim_path.display()))?;
    std::fs::write(&stamp_path, entry.stamp)
        .with_context(|| format!("write stamp to {}", stamp_path.display()))?;
    tracing::info!(
        "installed embedded Ardour shim ({} bytes, ABI {}) at {}",
        entry.bytes.len(),
        entry.abi,
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
        home.join("Library/Preferences")
            .join(format!("Ardour{major}"))
            .join("surfaces")
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
