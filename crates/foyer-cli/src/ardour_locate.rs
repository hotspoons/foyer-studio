// Ardour binary discovery + version probe.
//
// Split out of `shim_install.rs` so the desktop shell's native-Ardour
// host-mode path can resolve + version-gate an installed Ardour
// without dragging the embedded-shim install logic along. The shim
// install module re-uses `resolve_ardour_binary` for its own
// preflight; this module's `locate()` returns a richer record (binary
// + version + optional macOS .app bundle root) that the picker uses
// to render install-state cards.

use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::shim_install::ARDOUR_VERSION;

/// Result of a discovery pass. `bundle_root` is the `/Applications/
/// Ardour9.app` path on macOS (None on Linux or when the user has
/// installed a raw binary); the desktop launcher uses this for
/// AppleScript "tell application Ardour9 to quit" wiring + ad-hoc
/// signature checks. `version` is the semver triple parsed from
/// `ardour --version` — None when the probe failed (Ardour exists
/// but errored on --version; treat as "unknown version, attempt
/// anyway").
#[derive(Debug, Clone)]
pub struct ArdourLocation {
    pub binary: PathBuf,
    pub bundle_root: Option<PathBuf>,
    pub version: Option<Version>,
}

/// Parsed Ardour version. `patch` is optional because Ardour
/// occasionally ships a bare `9.2` without a third component.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: Option<u32>,
}

impl Version {
    pub fn parse(s: &str) -> Option<Version> {
        let mut parts = s.split(['.', '-']);
        let major: u32 = parts.next()?.parse().ok()?;
        let minor: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
        let patch: Option<u32> = parts.next().and_then(|p| p.parse().ok());
        Some(Version {
            major,
            minor,
            patch,
        })
    }

    pub fn as_string(&self) -> String {
        match self.patch {
            Some(p) => format!("{}.{}.{}", self.major, self.minor, p),
            None => format!("{}.{}", self.major, self.minor),
        }
    }

    /// True when `self` is in the same major.minor band as `other`.
    /// Foyer's shim ABI guards on major.minor (a 9.5 shim works
    /// against 9.5.x point releases but not 9.6+ or 9.4-).
    pub fn major_minor_matches(&self, other: &Version) -> bool {
        self.major == other.major && self.minor == other.minor
    }
}

/// Discovery: probe the well-known locations, return the first hit.
/// Mirrors `shim_install::resolve_ardour_binary` order but returns a
/// richer `ArdourLocation` instead of a bare `PathBuf`. Caller
/// distinguishes "no Ardour at all" (Err) from "Ardour present but
/// version unknown" (Ok with `version: None`).
pub fn locate(override_path: Option<&Path>) -> Result<ArdourLocation> {
    let binary = resolve_binary(override_path)?;
    let bundle_root = bundle_root_for(&binary);
    let version = probe_version(&binary);
    Ok(ArdourLocation {
        binary,
        bundle_root,
        version,
    })
}

/// Best-effort resolve. Order of preference:
///   1. Explicit override (`--ardour-path` or config).
///   2. Major-pinned name (`ardour9`) on PATH.
///   3. Bare `ardour` on PATH.
///   4. macOS app bundle's inner executable.
///   5. Distro-canonical install paths.
fn resolve_binary(override_path: Option<&Path>) -> Result<PathBuf> {
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
    let names: &[String] = &[
        format!("ardour{major}"),
        "ardour".into(),
        format!("Ardour{major}"),
    ];
    for n in names {
        if let Some(p) = which(n) {
            return Ok(p);
        }
    }
    // Well-known install locations. On macOS we look inside the .app
    // bundle; the bundle's inner Mach-O is what we actually exec.
    let candidates = [
        PathBuf::from(format!("/usr/bin/ardour{major}")),
        PathBuf::from(format!("/usr/local/bin/ardour{major}")),
        PathBuf::from(format!("/opt/Ardour-{ARDOUR_VERSION}/bin/ardour{major}")),
        PathBuf::from(format!(
            "/Applications/Ardour{major}.app/Contents/MacOS/Ardour{major}"
        )),
        // ~/Applications/Ardour9.app — drag-installed but not into
        // /Applications. dirs crate is already a workspace dep; use
        // it instead of HOME-string-joining for Windows symmetry
        // (though Ardour doesn't run there).
        dirs::home_dir()
            .map(|h| {
                h.join(format!(
                    "Applications/Ardour{major}.app/Contents/MacOS/Ardour{major}"
                ))
            })
            .unwrap_or_default(),
    ];
    for p in candidates {
        if p.is_file() {
            return Ok(p);
        }
    }
    Err(anyhow!(
        "could not find an Ardour {ARDOUR_VERSION} executable.\n\
         · install Ardour from https://ardour.org/ (Debian/Ubuntu: `apt install ardour`)\n\
         · macOS: download from https://community.ardour.org/download\n\
         · or set `ardour.binary` in your config.yaml / pass `--ardour-path <bin>`\n\
         · or run without Ardour by passing `--backend stub`"
    ))
}

/// On macOS, an Ardour binary at `…/Foo.app/Contents/MacOS/Bar` is
/// the inner Mach-O of a bundle; the bundle root is two `parent()`
/// calls up. Returns None for Linux (no bundle concept) and for
/// macOS binaries installed outside a bundle.
fn bundle_root_for(binary: &Path) -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let macos_dir = binary.parent()?;
    if macos_dir.file_name()?.to_str()? != "MacOS" {
        return None;
    }
    let contents = macos_dir.parent()?;
    if contents.file_name()?.to_str()? != "Contents" {
        return None;
    }
    let root = contents.parent()?;
    if root.extension().and_then(|s| s.to_str()) == Some("app") {
        Some(root.to_path_buf())
    } else {
        None
    }
}

/// Spawn `ardour --version` and parse the version-shaped token.
/// Returns None on any failure — the caller decides whether to
/// proceed without a version (we usually do, with a warning).
fn probe_version(binary: &Path) -> Option<Version> {
    let out = Command::new(binary).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8(out.stdout).ok()?;
    // Lines look like `ardour9 9.2.0` or `Ardour 9.2`. Take the
    // first version-shaped token.
    for tok in stdout.split_whitespace() {
        if tok.chars().next().is_some_and(|c| c.is_ascii_digit()) && tok.contains('.') {
            if let Some(v) = Version::parse(tok) {
                return Some(v);
            }
        }
    }
    None
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

/// JSON shape consumed by the desktop picker's `doctor-ardour`
/// payload. Mirrors the host_doctor check shape so the picker can
/// render it with the same component.
pub fn locate_to_json(loc: Option<&ArdourLocation>) -> String {
    let expected = ARDOUR_VERSION;
    match loc {
        Some(l) => {
            let version_str = l.version.as_ref().map(|v| v.as_string());
            let version_ok = l
                .version
                .as_ref()
                .zip(Version::parse(expected))
                .map(|(installed, want)| installed.major_minor_matches(&want))
                .unwrap_or(false);
            let bundle = l.bundle_root.as_ref().map(|p| p.display().to_string());
            let mut s = String::from("{");
            s.push_str(&format!(
                "\"installed\":true,\"binary\":{},\"expected_version\":{},",
                json_str(&l.binary.display().to_string()),
                json_str(expected),
            ));
            s.push_str(&format!(
                "\"version\":{},\"version_ok\":{},",
                match &version_str {
                    Some(v) => json_str(v),
                    None => "null".into(),
                },
                version_ok,
            ));
            s.push_str(&format!(
                "\"bundle_root\":{}",
                match &bundle {
                    Some(b) => json_str(b),
                    None => "null".into(),
                }
            ));
            s.push('}');
            s
        }
        None => format!(
            "{{\"installed\":false,\"expected_version\":{}}}",
            json_str(expected)
        ),
    }
}

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
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
