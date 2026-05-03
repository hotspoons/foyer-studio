// SPDX-License-Identifier: Apache-2.0
//! OCI image / Dockerfile generation.

use std::collections::HashSet;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::SnapshotPlan;

/// Build a `tokio::process::Command` for the docker invocation. Honors
/// `FOYER_DOCKER` so callers can swap in `sudo docker`, `podman`, or a
/// rootless-docker socket without recompiling. Defaults to `docker`.
///
/// We need this because dev containers commonly mount the host docker
/// socket but only let `root` use it — meaning every docker call from
/// our process either segfaults at exec or returns exit 126 ("command
/// found but not executable" → permission denied on /var/run/docker.sock).
/// The probe + build both go through here so a single env var fixes
/// both paths.
fn docker_cmd() -> tokio::process::Command {
    let raw = std::env::var("FOYER_DOCKER").unwrap_or_else(|_| "docker".to_string());
    let mut parts = raw.split_whitespace();
    let bin = parts.next().unwrap_or("docker");
    let mut cmd = tokio::process::Command::new(bin);
    for arg in parts {
        cmd.arg(arg);
    }
    cmd
}

/// Detect the base OS image matching the current host.
///
/// If the DAW executable comes from Debian `sid`/`unstable`, we prefer
/// `debian:unstable-slim` because the package set in the stable base
/// image (e.g. `debian:13-slim`) may have an older major version of
/// the DAW or incompatible library SONAMEs.
pub async fn detect_base_os() -> Result<String> {
    let mut distro = "debian".to_string();
    let mut version = "bookworm".to_string();

    let id = tokio::fs::read_to_string("/etc/os-release")
        .await
        .unwrap_or_default();
    if !id.is_empty() {
        let distro_line = id.lines().find(|l| l.starts_with("ID="));
        let ver_line = id.lines().find(|l| l.starts_with("VERSION_CODENAME="));
        let ver_id_line = id.lines().find(|l| l.starts_with("VERSION_ID="));
        if let Some(l) = distro_line {
            distro = l.trim_start_matches("ID=").trim_matches('"').to_string();
        }
        version = if let Some(l) = ver_line {
            l.trim_start_matches("VERSION_CODENAME=")
                .trim_matches('"')
                .to_string()
        } else if let Some(l) = ver_id_line {
            l.trim_start_matches("VERSION_ID=")
                .trim_matches('"')
                .to_string()
        } else {
            version.to_string()
        };
    }

    // Check for sid/unstable pin — if present, unstable packages dominate
    // the installed set and the base image must match.
    if tokio::fs::metadata("/etc/apt/sources.list.d/sid.list")
        .await
        .is_ok()
        || tokio::fs::metadata("/etc/apt/sources.list")
            .await
            .is_ok_and(|m| m.is_file())
            && tokio::fs::read_to_string("/etc/apt/sources.list")
                .await
                .unwrap_or_default()
                .contains("sid")
    {
        return Ok("debian:unstable-slim".into());
    }

    Ok(format!("{}:{}-slim", distro, version))
}

/// Enumerate the basenames of every shared library shipped by the base
/// image's `/lib` and `/usr/lib` trees. Used to gate which host
/// libraries we copy into `/opt/foyer-syslibs`: if the base already
/// has a file with the same basename, copying the host's version on top
/// (via global `LD_LIBRARY_PATH`) would override the base's
/// glibc-compatible build with a newer one and segfault every binary
/// in the container — including `sh`, `find`, and `apt`.
///
/// The previous design used a hard-coded blocklist of glibc / NSS /
/// ld-linux names. That worked for the glibc segfault case but didn't
/// generalize: any library that the base also ships (libstdc++,
/// libgcc_s, libz, libuuid, etc.) carried the same risk and was not
/// filtered. SONAME-by-basename diff catches all of those.
///
/// Implementation note: we use `find -printf '%f\n'` which emits just
/// the basename per line. Bare-bones `slim` images don't include
/// `objdump`, so true SONAME extraction would require staging
/// `binutils` in the probe container — basename equivalence is good
/// enough because Linux dynamic loader resolution is keyed on SONAME
/// which lives in the file's name in practice.
///
/// On `docker run` failure (no Docker daemon, no network, weird base
/// image), returns an empty set. Callers should treat empty as
/// "filter disabled" and fall back to the static glibc blocklist in
/// `collect_symlink_chain`.
pub async fn enumerate_base_lib_basenames(base_image: &str) -> Result<HashSet<String>> {
    tracing::info!("enumerating base-image libraries from {base_image}");
    let out = docker_cmd()
        .args([
            "run",
            "--rm",
            "--entrypoint",
            "",
            base_image,
            "sh",
            "-c",
            "find /lib /usr/lib /lib64 /usr/lib64 -xdev -name '*.so*' \
             -printf '%f\\n' 2>/dev/null | sort -u",
        ])
        .output()
        .await
        .with_context(|| format!("docker run --rm {base_image} (probe libs)"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let hint = if out.status.code() == Some(126) || stderr.contains("permission denied") {
            " — looks like a docker-socket permission issue. Set `FOYER_DOCKER=\"sudo docker\"` (or add the user to the `docker` group) and retry."
        } else {
            ""
        };
        tracing::warn!(
            "base-lib enumeration failed (status {}{hint}); syslib filter will fall back to the static glibc blocklist",
            out.status,
        );
        return Ok(HashSet::new());
    }
    let names: HashSet<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    tracing::info!("base image ships {} library basenames", names.len());
    Ok(names)
}

/// Write a `Dockerfile` plus supporting build context into `out_dir`.
pub fn emit_dockerfile(plan: &SnapshotPlan, out_dir: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(out_dir)?;

    let dockerfile = out_dir.join("Dockerfile");
    let mut buf = String::new();

    // Stage 0: base OS — install runtime deps that Ardour assumes
    // exist on a normal desktop install but `slim` images don't ship.
    //   * fontconfig → silences "could not load fonts" warnings on
    //     headless boot. Optional but cheap and noisy.
    //   * binutils   → ships `nm` and `libbfd`. The Ardour wrapper
    //     calls `nm` to probe glib's atomic ops; without binutils it
    //     errors out and Ardour's init logs `libbfd-*-system.so:
    //     cannot open shared object`. (Handoff blockers #3 + #5.)
    //   * libpulse0  → libpulse is a soft-dep. If a host's libpulse
    //     isn't trivially copyable (e.g. SONAME version skew) it's
    //     simpler to apt-install.
    writeln!(
        &mut buf,
        "# syntax=docker/dockerfile:1\nFROM {} AS base",
        plan.base_image
    )?;
    writeln!(
        &mut buf,
        "RUN apt-get update \\\n  \
         && apt-get install -y --no-install-recommends \\\n      \
            fontconfig binutils xvfb xauth \\\n      \
            adwaita-icon-theme hicolor-icon-theme \\\n      \
            gsettings-desktop-schemas dbus-x11 \\\n      \
            shared-mime-info \\\n  \
         && rm -rf /var/lib/apt/lists/*"
    )?;
    writeln!(&mut buf)?;

    // Per-layer stages (only COPY, no ENV — env vars are deferred to final
    // stage so intermediate RUN commands don't pick up LD_LIBRARY_PATH that
    // points to host-copied libs with potentially wrong ABI).
    let mut prev_stage = "base".to_string();
    for (idx, layer) in plan.layers.iter().enumerate() {
        if layer.from_deb && layer.deb_package.is_some() {
            continue;
        }

        let stage_name = format!("layer_{}_{}", idx, sanitize(&layer.id));
        writeln!(
            &mut buf,
            "FROM {prev_stage} AS {stage_name}",
            prev_stage = prev_stage,
            stage_name = stage_name
        )?;

        let rel = format!("layer{idx}");
        let layer_ctx = out_dir.join(&rel);
        copy_tree(&layer.source_root, &layer_ctx)?;
        if layer.source_root.is_file() {
            // File-source layer (e.g. `daw-wrapper` = just /usr/bin/ardour).
            // Build context contains `layerN/<filename>`; the Dockerfile
            // COPY targets the full destination file path so the file
            // lands at exactly that path without wrapping it in a dir.
            let name = layer
                .source_root
                .file_name()
                .context("file source has no name")?
                .to_string_lossy()
                .into_owned();
            writeln!(
                &mut buf,
                "COPY {rel}/{name} {dest}",
                rel = rel,
                name = name,
                dest = layer.dest_root.display()
            )?;
        } else {
            writeln!(
                &mut buf,
                "COPY {rel} {dest}",
                rel = rel,
                dest = layer.dest_root.display()
            )?;
        }

        prev_stage = stage_name;
        writeln!(&mut buf)?;
    }

    // Final stage: project layer + all env vars.
    writeln!(
        &mut buf,
        "FROM {prev_stage} AS project",
        prev_stage = prev_stage
    )?;
    let project_rel = "project";
    let project_ctx = out_dir.join(project_rel);
    copy_tree(&plan.project_dir, &project_ctx)?;
    writeln!(
        &mut buf,
        "COPY {project_rel} {dest}",
        dest = plan.project_dir.display()
    )?;

    // Normalise mtimes so the layer is content-addressable.
    writeln!(
        &mut buf,
        "RUN find {} -exec touch -t 197001010000 {{}} +",
        plan.project_dir.display()
    )?;

    // Collect env vars from layers + runtime env. Multiple layers can
    // contribute the same key (notably `LD_LIBRARY_PATH`); de-dup by
    // key, last-write-wins.
    let mut envs: Vec<(String, String)> = Vec::new();
    for layer in &plan.layers {
        for (k, v) in &layer.env {
            envs.push((k.clone(), v.clone()));
        }
        if let Some(prefix) = &layer.wine_prefix {
            envs.push(("WINEPREFIX".into(), prefix.display().to_string()));
        }
    }
    for (k, v) in &plan.runtime_env {
        envs.push((k.clone(), v.clone()));
    }

    // LV2 search path: bake in the dirs we actually copied plugins
    // into, then the standard Ardour LV2 lookup roots so apt-installed
    // plugins (calf, etc.) still resolve. The container runs as root
    // so include `/root/.lv2` even though we only copied to
    // `/home/vscode/.lv2` — being permissive is harmless.
    if !plan.lv2_search_roots.is_empty() {
        let mut paths: Vec<String> = plan
            .lv2_search_roots
            .iter()
            .map(|p| p.display().to_string())
            .collect();
        for std_root in &["/usr/lib/lv2", "/usr/local/lib/lv2", "/root/.lv2"] {
            let s = std_root.to_string();
            if !paths.contains(&s) {
                paths.push(s);
            }
        }
        envs.push(("LV2_PATH".into(), paths.join(":")));
    }

    // Dedup, last-write-wins. Stable order — the last occurrence of
    // each key wins, but we preserve the relative order of FIRST
    // appearance so the Dockerfile reads top-down predictably.
    let mut seen_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut deduped: Vec<(String, String)> = Vec::new();
    // Walk in reverse to grab the latest value, then re-reverse for
    // output — the result keeps the LAST value for each key in the
    // ORDER of its first appearance.
    let mut last_for_key: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for (k, v) in &envs {
        last_for_key.insert(k.clone(), v.clone());
    }
    for (k, _) in &envs {
        if seen_keys.insert(k.clone()) {
            if let Some(v) = last_for_key.get(k) {
                deduped.push((k.clone(), v.clone()));
            }
        }
    }

    for (k, v) in deduped {
        writeln!(&mut buf, "ENV {k}=\"{v}\"")?;
    }

    // Wrap the entrypoint with `xvfb-run` so GUI Ardour boots without a
    // real X server. Headless containers have no display; the wrapper
    // script (`/usr/bin/ardour`) expects one and the audio engine
    // selection logic only fires after the GUI initializes — meaning
    // even with `try-autostart-engine=1` and a `Foyer Dummy` backend
    // configured, you only get to it via the GUI path. `xvfb-run -a`
    // picks a free display number; `--server-args` pins a 1920×1080×24
    // virtual screen so Ardour's "screen too tall" gate is silent and
    // every modal has room (matches the Cloud Run entrypoint's Xvfb
    // sizing in scripts/runtime/entrypoint.sh).
    writeln!(
        &mut buf,
        "ENTRYPOINT [\"xvfb-run\", \"-a\", \"--server-args=-screen 0 1920x1080x24\", \"{}\"]",
        plan.entrypoint.display()
    )?;
    writeln!(
        &mut buf,
        "CMD [\"{}\", \"{}\"]",
        plan.project_dir.display(),
        plan.snapshot_name
    )?;

    if !plan.unresolved.is_empty() {
        writeln!(&mut buf)?;
        writeln!(
            &mut buf,
            "# WARNING: {} plugin(s) referenced by this session could not be found on the host",
            plan.unresolved.len()
        )?;
        for u in &plan.unresolved {
            writeln!(
                &mut buf,
                "#   MISSING: {} ({}) — {}",
                u.id, u.format, u.reason
            )?;
        }
        writeln!(
            &mut buf,
            "# The session may fail to load or produce silence."
        )?;
    }

    std::fs::write(&dockerfile, buf)?;
    Ok(dockerfile)
}

pub async fn build_oci_tarball(plan: &SnapshotPlan, out_dir: &Path, tag: &str) -> Result<PathBuf> {
    let ctx = out_dir.join("oci-context");
    emit_dockerfile(plan, &ctx)?;

    let tar_path = out_dir.join(format!("{}.tar.gz", sanitize(tag)));
    let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
        std::fs::File::create(&tar_path)?,
        flate2::Compression::default(),
    ));

    tar.append_dir_all(".", &ctx)
        .with_context(|| format!("tar up build context {}", ctx.display()))?;
    tar.finish()?;

    Ok(tar_path)
}

pub async fn build_image(plan: &SnapshotPlan, out_dir: &Path, tag: &str) -> Result<()> {
    let ctx = out_dir.join("oci-context");
    emit_dockerfile(plan, &ctx)?;

    let status = docker_cmd()
        .args([
            "buildx",
            "build",
            "--tag",
            tag,
            ctx.display().to_string().as_str(),
        ])
        .status()
        .await
        .with_context(|| "spawn docker buildx build")?;
    if !status.success() {
        anyhow::bail!("docker buildx build failed");
    }
    Ok(())
}

fn copy_tree(src: &Path, dst: &Path) -> Result<()> {
    // Single-file source: stage a build-context dir containing just
    // that one file (named the same as src). The Dockerfile COPY at
    // dest then lays it down without touching sibling files in the
    // container's destination directory. Used by `daw-wrapper` which
    // needs to drop /usr/bin/ardour without overwriting /usr/bin/nm
    // and friends.
    if src.is_file() {
        std::fs::create_dir_all(dst)?;
        let name = src.file_name().context("file source has no name")?;
        let target = dst.join(name);
        std::fs::copy(src, &target)?;
        return Ok(());
    }

    std::fs::create_dir_all(dst)?;
    for entry in walkdir::WalkDir::new(src) {
        let entry = entry?;
        let rel = entry.path().strip_prefix(src)?;
        let target = dst.join(rel);

        let ft = entry.file_type();
        if ft.is_symlink() {
            let link_target = std::fs::read_link(entry.path())?;
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(&link_target, &target)?;
            }
            #[cfg(not(unix))]
            {
                if link_target.is_file() {
                    std::fs::copy(entry.path(), &target)?;
                }
            }
        } else if ft.is_dir() {
            std::fs::create_dir_all(&target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn sanitize(s: &str) -> String {
    s.replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "_")
}
