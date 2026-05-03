// SPDX-License-Identifier: Apache-2.0
//! Dependency tracing — shared libraries, Debian packages, Wine.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use tokio::process::Command;

use crate::project::PluginRef;
use crate::{DebDependency, Layer};

/// Find the Ardour (or compatible) executable on `$PATH`.
pub async fn resolve_daw_executable() -> Result<PathBuf> {
    for name in &[
        "ardour9", "ardour8", "ardour7", "ardour6", "hardour9", "hardour8",
    ] {
        if let Ok(out) = Command::new("which").arg(name).output().await {
            if out.status.success() {
                let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !path.is_empty() {
                    return Ok(PathBuf::from(path));
                }
            }
        }
    }
    anyhow::bail!("no Ardour executable found on $PATH")
}

/// Trace everything the DAW needs.
///
/// Strategy:
/// 1. Wrapper script (if any) → COPY
/// 2. Real binary tree (e.g. /usr/lib/ardour9) → COPY
/// 3. Shared libraries that resolve *outside* the binary tree → COPY into
///    a staging dir that becomes `/opt/foyer-syslibs` in the container.
///    This is essential when the host runs a newer distro snapshot (sid)
///    than the target base image (trixie).
/// 4. Data files (/usr/share/ardour9) → COPY
/// 5. Config files (/etc/ardour9) → COPY
///
/// Debian package names are tracked for reference but we do NOT install
/// `ardour` via apt because the target base image may have a different
/// major version.
pub async fn trace_daw(
    exec: &Path,
    seen: &mut HashSet<PathBuf>,
    base_libs: &HashSet<String>,
) -> Result<(PathBuf, Vec<Layer>, Vec<DebDependency>)> {
    let real_binary = resolve_real_binary(exec).await?;

    let entrypoint = if exec.exists() && is_shell_wrapper(exec).await? {
        exec.to_path_buf()
    } else {
        real_binary.clone()
    };

    let mut layers = Vec::new();
    let mut debs = Vec::new();
    let mut pkgs = HashSet::new();

    // ── Package metadata ────────────────────────────────────────────
    for path in [exec, &real_binary] {
        if let Some(pkg) = dpkg_owning_file(path).await? {
            pkgs.insert(pkg);
        }
    }
    // ldd WITH the library path so private libs resolve.
    let libs = ldd_with_ldpath(&real_binary, Some("/usr/lib/ardour9")).await?;
    for lib in &libs {
        if let Some(pkg) = dpkg_owning_file(lib).await? {
            pkgs.insert(pkg);
        }
    }
    if pkgs.iter().any(|p| p.starts_with("ardour")) {
        for s in &["ardour-data", "ardour-lv2-plugins"] {
            if command_success("dpkg", &["-s", s]).await? {
                pkgs.insert(s.to_string());
            }
        }
    }
    for pkg in &pkgs {
        debs.push(DebDependency {
            package: pkg.clone(),
            version: dpkg_version(pkg).await.ok(),
            paths: dpkg_list_files(pkg).await.unwrap_or_default(),
        });
    }

    // ── COPY layers ─────────────────────────────────────────────────
    let bin_dir = real_binary
        .parent()
        .unwrap_or(Path::new("/usr/lib/ardour9"));

    // Wrapper script. Copy ONLY the wrapper file, not its parent
    // directory — `/usr/bin/ardour` is a wrapper but `/usr/bin` is
    // also the home of `nm`, `find`, `apt-get`, etc., and the host's
    // versions of those are linked against host-version libs that the
    // container doesn't have. Copying all of /usr/bin shadows the
    // base image's binaries with broken host copies. This is what
    // produced the recurring `libbfd-2.44-system.so: cannot open
    // shared object file` errors during Ardour init: the host's
    // `/usr/bin/nm` overlaid the base's, but its libbfd never came
    // along.
    //
    // Layer source/dest are file paths (not dirs). copy_tree handles
    // file sources by writing a single file into the build context;
    // the Dockerfile COPY then lays it down at the matching file
    // path inside the container without disturbing siblings.
    if entrypoint != real_binary && exec.is_file() {
        layers.push(Layer::new("daw-wrapper", exec, exec));
    }

    // Binary tree. Bake in the env vars Ardour's wrapper script would
    // normally export — `LD_LIBRARY_PATH` so libardourcp.so etc.
    // resolve, `ARDOUR_DATA_PATH`/`ARDOUR_CONFIG_PATH`/`ARDOUR_DLL_PATH`
    // because the binary reads them at startup, and `GTK_PATH` so the
    // GUI's theme engine finds its module dir. Without these, calling
    // the binary directly (or `hardour`, which has no wrapper) errors
    // out with `libardourcp.so: cannot open shared object file`.
    let suffix = guess_ardour_major(&real_binary);
    let data_path = format!("/usr/share/ardour{suffix}");
    let cfg_path = format!("/etc/ardour{suffix}");
    let dll_path = bin_dir.display().to_string();
    let gtk_path = format!("{cfg_path}:{dll_path}");
    layers.push(
        Layer::new("daw-bin", bin_dir, bin_dir)
            .with_env("ARDOUR_DATA_PATH", data_path.clone())
            .with_env("ARDOUR_CONFIG_PATH", cfg_path.clone())
            .with_env("ARDOUR_DLL_PATH", dll_path.clone())
            .with_env("GTK_PATH", gtk_path),
    );

    // System libraries outside the binary dir. We filter out anything
    // the base image already ships (by basename) so the host's newer
    // glibc / libstdc++ / etc. don't shadow the base's via
    // `LD_LIBRARY_PATH`. The fall-through (when `base_libs` is empty)
    // is the static glibc blocklist inside `collect_symlink_chain`,
    // which catches the most catastrophic case (libc segfault).
    let mut syslibs: Vec<PathBuf> = libs
        .into_iter()
        .filter(|l| !l.starts_with(bin_dir))
        .collect();
    if !base_libs.is_empty() {
        let before = syslibs.len();
        syslibs.retain(|l| {
            let name = l
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            // Keep only libs the base does NOT ship. If base has the
            // same SONAME (basename in practice), the dynamic loader
            // will resolve from the base's standard path and our copy
            // would be a noop at best, an ABI hazard at worst.
            !base_libs.contains(&name)
        });
        tracing::info!(
            "syslib filter: {before} → {after} (dropped {drop} that the base image already ships)",
            after = syslibs.len(),
            drop = before - syslibs.len(),
        );
    }
    // Set the runtime LD_LIBRARY_PATH to bin_dir first (so Ardour's
    // private libs win) plus /opt/foyer-syslibs second (host-only
    // dependencies). Even with no syslib stage we still need the
    // binary dir on the path or hardour fails to find libardourcp.so.
    let syslib_dir = Path::new("/opt/foyer-syslibs");
    let ld_path = if syslibs.is_empty() {
        dll_path.clone()
    } else {
        format!("{}:{}", dll_path, syslib_dir.display())
    };
    if !syslibs.is_empty() {
        // Staging on the build host (outside project dir).
        let host_stage = std::env::temp_dir().join(format!("foyer-syslibs-{}", std::process::id()));
        std::fs::create_dir_all(&host_stage)?;
        collect_symlink_chain(&syslibs, &host_stage)?;

        layers.push(
            Layer::new("daw-syslibs", &host_stage, syslib_dir)
                .with_env("LD_LIBRARY_PATH", ld_path.clone()),
        );

        for p in &syslibs {
            seen.insert(p.clone());
        }
    } else {
        // No syslib layer means we still need to publish
        // LD_LIBRARY_PATH=bin_dir so the runtime ENV is set. Stash
        // it on the daw-bin layer's env (already added above) by
        // appending here — Layer::env is just a Vec.
        if let Some(bin_layer) = layers.iter_mut().rev().find(|l| l.id == "daw-bin") {
            bin_layer
                .env
                .push(("LD_LIBRARY_PATH".to_string(), ld_path.clone()));
        }
    }

    // Data files.
    for data_dir in &[
        PathBuf::from(format!("/usr/share/ardour{suffix}")),
        PathBuf::from("/usr/share/ardour9"),
        PathBuf::from("/usr/share/ardour8"),
    ] {
        if data_dir.exists() {
            layers.push(Layer::new("daw-data", data_dir, data_dir));
            break;
        }
    }

    // Config files.
    for cfg_dir in &[
        PathBuf::from(format!("/etc/ardour{suffix}")),
        PathBuf::from("/etc/ardour9"),
        PathBuf::from("/etc/ardour8"),
    ] {
        if cfg_dir.exists() {
            layers.push(Layer::new("daw-config", cfg_dir, cfg_dir));
            break;
        }
    }

    // User-config XML — picks the audio backend (`Foyer Dummy`),
    // plumbs `try-autostart-engine=1`, and points at the custom audio
    // backend `.so` we ship alongside it. Without this, Ardour boots
    // into a JACK-first state; the container has no JACK; init fails
    // with `Cannot start Audio/MIDI engine` and the session never
    // loads.
    //
    // The container runs as root by default so the destination is
    // `/root/.config/ardour9/`. We deliberately copy a SUBSET of the
    // host's user-config dir — `config` (the XML) and `backends/`
    // (the dummy backend `.so` plus any other registered backend) —
    // and skip `recent/`, `plugin_metadata/`, `sfdb/`, etc. so the
    // image doesn't leak host history. If those subdirs don't exist
    // on the host, this is a no-op.
    let host_cfg = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("/etc"))
        .join(format!("ardour{suffix}"));
    if host_cfg.exists() {
        let staged =
            std::env::temp_dir().join(format!("foyer-userconf-{}-{suffix}", std::process::id()));
        let _ = std::fs::remove_dir_all(&staged);
        std::fs::create_dir_all(&staged)?;
        // Plain files at the top level: `config` (audio backend pin),
        // `instant.xml` (suppresses the "memory limit" warning dialog),
        // and `.a9` (zero-byte marker that tells Ardour "first-run
        // wizard has already run on this machine"). Without `.a9` the
        // GUI walks through theme picker / welcome panes on every
        // boot and hangs in xvfb because there's no human to click
        // "Done."
        for fname in &["config", "instant.xml", ".a9"] {
            let src = host_cfg.join(fname);
            if src.exists() {
                std::fs::copy(&src, staged.join(fname))?;
            }
        }
        let backends_dir = host_cfg.join("backends");
        if backends_dir.exists() {
            let staged_backends = staged.join("backends");
            std::fs::create_dir_all(&staged_backends)?;
            for ent in std::fs::read_dir(&backends_dir)? {
                let ent = ent?;
                let ft = ent.file_type()?;
                if ft.is_file() || ft.is_symlink() {
                    std::fs::copy(ent.path(), staged_backends.join(ent.file_name()))?;
                }
            }
        }
        // Only emit the layer if we actually staged something.
        if std::fs::read_dir(&staged)?.next().is_some() {
            let dest = PathBuf::from(format!("/root/.config/ardour{suffix}"));
            layers.push(Layer::new("daw-user-config", staged, dest));
        }
    }

    Ok((entrypoint, layers, debs))
}

/// Trace a plugin binary.
pub async fn trace_plugin(
    path: &Path,
    _seen: &mut HashSet<PathBuf>,
) -> Result<(Layer, Option<DebDependency>)> {
    let id = format!(
        "plugin-{}-{}",
        path.file_stem().unwrap_or_default().to_string_lossy(),
        short_hash(path)
    );
    let dest = path.parent().unwrap_or(Path::new("/usr/lib")).to_path_buf();

    let owner_pkg = dpkg_owning_file(path).await?;
    let mut layer = Layer::new(&id, &dest, &dest);
    let mut deb_dep: Option<DebDependency> = None;

    if let Some(pkg) = &owner_pkg {
        layer = layer.with_deb(pkg.clone());
        deb_dep = Some(DebDependency {
            package: pkg.clone(),
            version: dpkg_version(pkg).await.ok(),
            paths: dpkg_list_files(pkg).await.unwrap_or_default(),
        });
    }
    Ok((layer, deb_dep))
}

/// Attempt to find the on-disk binary for a plugin reference.
pub async fn find_plugin_binary(r: &PluginRef) -> Result<Option<PathBuf>> {
    if let Some(p) = &r.explicit_path {
        if p.exists() {
            return Ok(Some(p.clone()));
        }
    }
    match r.format.as_str() {
        "lv2" | "lv2p" => find_lv2_binary(&r.id).await,
        "vst" | "lxvst" | "windows-vst" => find_vst_binary(&r.id).await,
        "vst3" | "vst3i" => find_vst3_binary(&r.id).await,
        "ladspa" | "ladspav2" => find_ladspa_binary(&r.id).await,
        _ => Ok(None),
    }
}

async fn find_lv2_binary(uri: &str) -> Result<Option<PathBuf>> {
    for root in &[
        Path::new("/usr/lib/lv2"),
        Path::new("/usr/local/lib/lv2"),
        &dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/"))
            .join(".lv2"),
    ] {
        if !root.exists() {
            continue;
        }
        let direct = root.join(uri.strip_prefix("https://").unwrap_or(uri));
        if direct.is_dir() {
            if let Some(so) = find_so_in_dir(&direct).await {
                return Ok(Some(so));
            }
        }
        let entries = walkdir::WalkDir::new(root)
            .max_depth(3)
            .into_iter()
            .filter_map(|e| e.ok());
        for entry in entries {
            let p = entry.path();
            if p.file_name() == Some(std::ffi::OsStr::new("manifest.ttl")) {
                if let Ok(text) = tokio::fs::read_to_string(p).await {
                    if text.contains(uri) {
                        if let Some(so) = find_so_in_dir(p.parent().unwrap()).await {
                            return Ok(Some(so));
                        }
                    }
                }
            }
        }
    }
    Ok(None)
}

async fn find_vst_binary(id: &str) -> Result<Option<PathBuf>> {
    for root in &[
        Path::new("/usr/lib/vst"),
        Path::new("/usr/local/lib/vst"),
        &dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/"))
            .join(".vst"),
        Path::new("/usr/lib/lxvst"),
    ] {
        if !root.exists() {
            continue;
        }
        let target = root.join(format!("{id}.so"));
        if target.exists() {
            return Ok(Some(target));
        }
        let dir_target = root.join(id);
        if dir_target.is_dir() {
            if let Some(so) = find_so_in_dir(&dir_target).await {
                return Ok(Some(so));
            }
        }
    }
    Ok(None)
}

async fn find_vst3_binary(id: &str) -> Result<Option<PathBuf>> {
    for root in &[
        Path::new("/usr/lib/vst3"),
        Path::new("/usr/local/lib/vst3"),
        &dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/"))
            .join(".vst3"),
    ] {
        if !root.exists() {
            continue;
        }
        let bundle = root.join(format!("{id}.vst3"));
        if bundle.is_dir() {
            if let Some(so) = find_so_in_dir(&bundle).await {
                return Ok(Some(so));
            }
        }
        let bundle2 = root.join(id);
        if bundle2.is_dir() {
            if let Some(so) = find_so_in_dir(&bundle2).await {
                return Ok(Some(so));
            }
        }
    }
    Ok(None)
}

async fn find_ladspa_binary(id: &str) -> Result<Option<PathBuf>> {
    for root in &[
        Path::new("/usr/lib/ladspa"),
        Path::new("/usr/local/lib/ladspa"),
        &dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/"))
            .join(".ladspa"),
    ] {
        if !root.exists() {
            continue;
        }
        let entries = walkdir::WalkDir::new(root)
            .max_depth(2)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("so"));
        for entry in entries {
            if entry.file_name().to_string_lossy().contains(id) {
                return Ok(Some(entry.path().to_path_buf()));
            }
        }
    }
    Ok(None)
}

async fn find_so_in_dir(dir: &Path) -> Option<PathBuf> {
    let mut entries: Vec<_> = walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("so"))
        .map(|e| e.path().to_path_buf())
        .collect();
    entries.sort();
    entries.into_iter().next()
}

/// Run `ldd` with optional `LD_LIBRARY_PATH`.
async fn ldd_with_ldpath(path: &Path, ld_path: Option<&str>) -> Result<Vec<PathBuf>> {
    let mut cmd = Command::new("ldd");
    if let Some(p) = ld_path {
        cmd.env("LD_LIBRARY_PATH", p);
    }
    let out = cmd
        .arg(path)
        .output()
        .await
        .with_context(|| format!("spawn ldd {}", path.display()))?;
    if !out.status.success() {
        return Ok(Vec::new());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut libs = Vec::new();
    for line in text.lines() {
        if let Some(arrow) = line.find("=>") {
            let part = &line[arrow + 2..];
            if let Some(paren) = part.find('(') {
                let lib = part[..paren].trim().to_string();
                if !lib.is_empty() && lib != "not found" {
                    libs.push(PathBuf::from(lib));
                }
            }
        }
    }
    Ok(libs)
}

/// Walk a list of library paths, following symlink chains, and copy
/// every real file + every symlink into `dest_dir`.
/// Collect system libraries into a staging directory, but skip glibc
/// core libraries that would break every binary in the container if
/// loaded from the host's newer libc.
fn collect_symlink_chain(origins: &[PathBuf], dest_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dest_dir)?;

    let mut walked = HashSet::new();
    for origin in origins {
        let mut current = origin.clone();
        while !walked.contains(&current) {
            walked.insert(current.clone());
            let name = current.file_name().unwrap_or_default();
            let name_str = name.to_string_lossy();

            // Skip glibc core libs — these must come from the base image.
            if name_str.starts_with("libc.so")
                || name_str.starts_with("libm.so")
                || name_str.starts_with("libdl.so")
                || name_str.starts_with("libpthread.so")
                || name_str.starts_with("librt.so")
                || name_str.starts_with("libresolv.so")
                || name_str.starts_with("libutil.so")
                || name_str.starts_with("libnss_")
                || name_str.starts_with("ld-linux")
            {
                break;
            }

            let staged = dest_dir.join(name);
            if !staged.exists() {
                if current.is_symlink() {
                    let link_target = std::fs::read_link(&current)?;
                    #[cfg(unix)]
                    {
                        std::os::unix::fs::symlink(&link_target, &staged)?;
                    }
                    #[cfg(not(unix))]
                    {
                        if link_target.is_file() {
                            std::fs::copy(&current, &staged)?;
                        }
                    }
                    current = if link_target.is_absolute() {
                        link_target
                    } else {
                        current.parent().unwrap().join(link_target)
                    };
                } else {
                    std::fs::copy(&current, &staged)?;
                    break;
                }
            } else {
                break;
            }
        }
    }
    Ok(())
}

async fn dpkg_owning_file(path: &Path) -> Result<Option<String>> {
    let out = Command::new("dpkg").arg("-S").arg(path).output().await?;
    if !out.status.success() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    parse_dpkg_search(&text)
}

/// Parse `dpkg -S <path>` output. Real-world output handles three shapes:
///
/// 1. Plain `pkg: path` (most common):
///    `libpulse0:arm64: /usr/lib/aarch64-linux-gnu/libpulse.so.0`
///
/// 2. Diverted file — emits two preamble lines AND the actual owner:
///    `diversion by libreadline8t64 from: /lib/.../libreadline.so.8`
///    `diversion by libreadline8t64 to:   /lib/.../libreadline.so.8.usr-is-merged`
///    `libreadline8t64:arm64: /lib/aarch64-linux-gnu/libreadline.so.8`
///
/// 3. Diverted file with no fallback owner line — only the preamble shows
///    up. The diverter IS the effective owner. (This is rare but happens
///    on packages that are pure diversions.)
///
/// Previous parser took `text.find(':')` and produced garbage like
/// `"diversion by libreadline8t64 from"` for case 2/3 — that name then
/// leaked into `deb_deps` and broke `apt-get install` in the Dockerfile.
///
/// New rules:
///   * Match the `pkg[:arch]: /path` shape by anchoring on `": /"` rather
///     than the first stray `:`.
///   * Strip the `:arch` qualifier so `apt-get install <name>` works.
///   * Skip diversion preambles, but remember the diverter as a fallback.
fn parse_dpkg_search(text: &str) -> Result<Option<String>> {
    let mut diverter: Option<String> = None;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("diversion by ") {
            // `diversion by <pkg> from:` / `... to:` — capture the
            // diverting package as a fallback.
            if let Some(end) = rest.find(' ') {
                diverter = Some(rest[..end].to_string());
            }
            continue;
        }
        if line.starts_with("local diversion") {
            // Pure local diversion (no package). Nothing useful here.
            continue;
        }
        // Real owner line — anchor on ": /" so `libpulse0:arm64` doesn't
        // trick us with its arch suffix colon.
        if let Some(colon) = line.find(": /") {
            let pkg_with_arch = line[..colon].trim();
            // Multiple packages can claim the same path (`pkg1, pkg2: /x`).
            // Keep the first; this matches dpkg's own ordering.
            let pkg = pkg_with_arch
                .split(',')
                .next()
                .unwrap_or(pkg_with_arch)
                .trim();
            // Strip arch qualifier (`libpulse0:arm64` → `libpulse0`) so
            // the name is apt-installable as-is.
            let pkg = pkg.split(':').next().unwrap_or(pkg).trim();
            if !pkg.is_empty() {
                return Ok(Some(pkg.to_string()));
            }
        }
    }
    Ok(diverter)
}

async fn dpkg_list_files(pkg: &str) -> Result<Vec<PathBuf>> {
    let out = Command::new("dpkg").arg("-L").arg(pkg).output().await?;
    if !out.status.success() {
        anyhow::bail!("dpkg -L {pkg} failed");
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(PathBuf::from)
        .collect())
}

async fn dpkg_version(pkg: &str) -> Result<String> {
    let out = Command::new("dpkg-query")
        .args(["-W", "-f=${Version}", pkg])
        .output()
        .await?;
    if !out.status.success() {
        anyhow::bail!("dpkg-query failed for {pkg}");
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

async fn command_success(cmd: &str, args: &[&str]) -> Result<bool> {
    Ok(Command::new(cmd)
        .args(args)
        .output()
        .await?
        .status
        .success())
}

/// Trace the Wine installation. Returns `None` if Wine is not present.
pub async fn trace_wine_installation(
    seen: &mut HashSet<PathBuf>,
) -> Result<Option<(Layer, Option<DebDependency>)>> {
    let out = Command::new("which").arg("wine").output().await?;
    if !out.status.success() {
        return Ok(None);
    }
    let wine_bin = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let wine_root = Path::new(&wine_bin)
        .parent()
        .and_then(|p| p.parent())
        .unwrap_or(Path::new("/usr"));

    let mut layer =
        Layer::new("wine-runtime", wine_root, wine_root).with_env("WINEPATH", "/usr/lib/wine");
    let libs = ldd_with_ldpath(Path::new(&wine_bin), None).await?;
    let mut deb = None;
    for lib in &libs {
        if seen.insert(lib.clone()) {
            if let Some(pkg) = dpkg_owning_file(lib).await? {
                deb = Some(DebDependency {
                    package: pkg.clone(),
                    version: dpkg_version(&pkg).await.ok(),
                    paths: dpkg_list_files(&pkg).await.unwrap_or_default(),
                });
                layer = layer.with_deb(pkg);
            }
        }
    }
    Ok(Some((layer, deb)))
}

fn short_hash(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(path.as_os_str().as_encoded_bytes());
    let result = h.finalize();
    hex::encode(&result[..4])
}

/// Resolve wrapper script → real ELF.
async fn resolve_real_binary(exec: &Path) -> Result<PathBuf> {
    if !is_shell_wrapper(exec).await? {
        return Ok(exec.to_path_buf());
    }

    let mut candidates = Vec::new();

    if let Some(_parent) = exec.parent() {
        let name = exec.file_stem().unwrap_or_default().to_string_lossy();
        let version_guess = if name.starts_with("ardour") || name.starts_with("hardour") {
            let suffix = name
                .trim_start_matches("ardour")
                .trim_start_matches("hardour");
            if suffix.is_empty() {
                "9"
            } else {
                suffix
            }
        } else {
            ""
        };

        if !version_guess.is_empty() {
            let lib_dir = Path::new("/usr/lib").join(format!("ardour{version_guess}"));
            candidates.push(lib_dir.join(format!("ardour-{version_guess}.2.0~ds")));
            candidates.push(lib_dir.join(format!("hardour-{version_guess}.2.0~ds")));
        }
    }

    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }

    let fallback = walkdir::WalkDir::new("/usr/lib")
        .max_depth(2)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file() && e.file_name().to_string_lossy().starts_with("ardour-")
        })
        .map(|e| e.path().to_path_buf())
        .next();

    if let Some(f) = fallback {
        return Ok(f);
    }

    Ok(exec.to_path_buf())
}

fn guess_ardour_major(path: &Path) -> String {
    path.components()
        .filter_map(|c| {
            let s = c.as_os_str().to_string_lossy();
            s.strip_prefix("ardour")
                .and_then(|v| v.chars().next().map(|c| c.to_string()))
        })
        .next()
        .unwrap_or_else(|| "9".into())
}

async fn is_shell_wrapper(path: &Path) -> Result<bool> {
    if let Ok(bytes) = tokio::fs::read(path).await {
        if bytes.starts_with(b"#!") {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod dpkg_tests {
    use super::parse_dpkg_search;

    #[test]
    fn plain_owner() {
        let out = "libpulse0:arm64: /usr/lib/aarch64-linux-gnu/libpulse.so.0\n";
        assert_eq!(
            parse_dpkg_search(out).unwrap().as_deref(),
            Some("libpulse0"),
        );
    }

    #[test]
    fn diversion_with_real_owner_after() {
        let out = "\
diversion by libreadline8t64 from: /lib/aarch64-linux-gnu/libreadline.so.8
diversion by libreadline8t64 to: /lib/aarch64-linux-gnu/libreadline.so.8.usr-is-merged
libreadline8t64:arm64: /lib/aarch64-linux-gnu/libreadline.so.8
";
        assert_eq!(
            parse_dpkg_search(out).unwrap().as_deref(),
            Some("libreadline8t64"),
        );
    }

    #[test]
    fn diversion_only_uses_diverter() {
        let out = "\
diversion by libreadline8t64 from: /lib/aarch64-linux-gnu/libreadline.so.8
diversion by libreadline8t64 to: /lib/aarch64-linux-gnu/libreadline.so.8.usr-is-merged
";
        assert_eq!(
            parse_dpkg_search(out).unwrap().as_deref(),
            Some("libreadline8t64"),
        );
    }

    #[test]
    fn no_match_returns_none() {
        let out = "dpkg-query: no path found matching pattern /nonexistent\n";
        assert_eq!(parse_dpkg_search(out).unwrap(), None);
    }
}
