// SPDX-License-Identifier: Apache-2.0
//! Foyer Snapshot — reproducible Ardour project packaging.
//!
//! Given an Ardour session directory, this crate:
//! 1. Parses the `.ardour` XML to discover every referenced plugin.
//! 2. Walks the DAW executable and plugins with `ldd` to build a DAG of
//!    shared-library dependencies.
//! 3. Maps files back to Debian packages (where possible) and copies
//!    ad-hoc installs (VST bundles, Wine prefixes, etc.) verbatim.
//! 4. Emits a multi-stage `Dockerfile` that layers the OS base, DAW,
//!    each plugin, and the project for maximum cache reuse.
//! 5. Builds a portable OCI tarball that can be loaded with `docker load`
//!    or pushed to a registry.

pub mod cli;
pub mod deps;
pub mod oci;
pub mod project;

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// A single directory tree that must be reproduced inside the container.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Layer {
    /// Human-readable label (e.g. `ardour-8`, `calf-lv2`, `wine-staging`).
    pub id: String,
    /// Absolute path on the **host** where the tree currently lives.
    pub source_root: PathBuf,
    /// Mount point inside the container.
    pub dest_root: PathBuf,
    /// If the entire tree comes from a Debian package, store the package
    /// name so the Dockerfile can `apt-get install` it instead of copying
    /// raw files.
    pub from_deb: bool,
    pub deb_package: Option<String>,
    /// Additional env vars that must be set for this layer to function.
    pub env: Vec<(String, String)>,
    /// If this layer is a Wine prefix, the `WINEPREFIX` value.
    pub wine_prefix: Option<PathBuf>,
}

impl Layer {
    pub fn new(
        id: impl Into<String>,
        source_root: impl Into<PathBuf>,
        dest_root: impl Into<PathBuf>,
    ) -> Self {
        Self {
            id: id.into(),
            source_root: source_root.into(),
            dest_root: dest_root.into(),
            from_deb: false,
            deb_package: None,
            env: Vec::new(),
            wine_prefix: None,
        }
    }

    pub fn with_deb(mut self, pkg: impl Into<String>) -> Self {
        self.from_deb = true;
        self.deb_package = Some(pkg.into());
        self
    }

    pub fn with_env(mut self, key: impl Into<String>, val: impl Into<String>) -> Self {
        self.env.push((key.into(), val.into()));
        self
    }

    pub fn with_wine_prefix(mut self, prefix: impl Into<PathBuf>) -> Self {
        self.wine_prefix = Some(prefix.into());
        self
    }
}

/// A plugin reference that could not be resolved to an on-disk file.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UnresolvedPlugin {
    pub id: String,
    pub format: String,
    pub reason: String,
}

/// A Debian package that the snapshot needs but that could not be mapped
/// to a `.deb` on disk (so we must `apt-get install` it in the Dockerfile).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DebDependency {
    pub package: String,
    pub version: Option<String>,
    pub paths: Vec<PathBuf>,
}

/// Discovered inputs for a single Ardour project.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SnapshotPlan {
    pub base_image: String,
    pub project_dir: PathBuf,
    pub snapshot_name: String,
    /// Entrypoint for the container.  When the DAW is a wrapper script
    /// (e.g. `/usr/bin/ardour`) this is the wrapper; otherwise the raw
    /// binary.
    pub entrypoint: PathBuf,
    /// Every filesystem layer, in dependency order.
    pub layers: Vec<Layer>,
    /// Debian packages that must be `apt-get install`-ed in the base
    /// layer because their files are scattered across the FS.
    pub deb_deps: Vec<DebDependency>,
    pub runtime_env: Vec<(String, String)>,
    pub unresolved: Vec<UnresolvedPlugin>,
    pub skipped: Vec<(String, String)>,
    /// Bundles search-roots discovered for LV2 plugins shipped with the
    /// session. We need these so the final-stage Dockerfile can emit
    /// `LV2_PATH=...`. Default Ardour LV2 lookup checks
    /// `/usr/lib/lv2`, `/usr/local/lib/lv2`, and `$HOME/.lv2`; the
    /// container runs as root so `$HOME=/root` and the host's
    /// `/home/vscode/.lv2` is invisible without an explicit env var.
    /// Populated even on success of system-path plugins (idempotent
    /// merge with the defaults). One path per element, deduped.
    pub lv2_search_roots: Vec<PathBuf>,
}

/// Generate a `SnapshotPlan` from a project directory.
pub async fn plan(project_dir: &Path, daw_exec: Option<&Path>) -> Result<SnapshotPlan> {
    let project_dir = std::fs::canonicalize(project_dir)
        .with_context(|| format!("canonicalize project dir {}", project_dir.display()))?;

    // 1. Parse the Ardour XML.
    let (snapshot_name, xml_path) = project::find_main_session_file(&project_dir)?;
    let inventory = project::extract_plugin_refs(&xml_path)?;

    tracing::info!(
        "project={} snapshot={} plugins={} skipped={}",
        project_dir.display(),
        snapshot_name,
        inventory.refs.len(),
        inventory.skipped.len()
    );
    for sk in &inventory.skipped {
        tracing::warn!("skipped processor format={} (built-in / unknown)", sk.0);
    }

    // 2. Detect base OS.
    let base = oci::detect_base_os().await?;
    tracing::info!("base-image={}", base);

    // 2a. Enumerate the libraries the base image ALREADY ships. We use
    // this to filter our syslib copy set so we don't override the
    // base's glibc/libstdc++/etc. with the host's newer versions —
    // every binary in the container loads against base's libc, and
    // copying host libc into LD_LIBRARY_PATH would segfault `sh`,
    // `find`, `apt`, etc. (Handoff blocker #2.) Empty = filter
    // disabled, fall back to the static glibc blocklist baked into
    // collect_symlink_chain.
    let base_libs = oci::enumerate_base_lib_basenames(&base)
        .await
        .unwrap_or_default();

    // 3. Resolve DAW executable.
    let daw = match daw_exec {
        Some(p) => std::fs::canonicalize(p)?,
        None => deps::resolve_daw_executable().await?,
    };

    // 4. Trace dependencies.
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut layers = Vec::new();
    let mut deb_deps = Vec::new();
    let mut unresolved = Vec::new();

    // 4a. DAW layer(s).
    let (entrypoint, daw_layers, daw_debs) = deps::trace_daw(&daw, &mut seen, &base_libs).await?;
    layers.extend(daw_layers);
    deb_deps.extend(daw_debs);

    // 4b. Plugin layers — one per unique plugin binary.
    let mut lv2_roots: Vec<PathBuf> = Vec::new();
    for (plugin_path, plugin_format) in
        resolve_plugin_paths(&inventory.refs, &mut unresolved).await?
    {
        let (plugin_layer, plugin_deb) = deps::trace_plugin(&plugin_path, &mut seen).await?;
        layers.push(plugin_layer);
        if let Some(d) = plugin_deb {
            deb_deps.push(d);
        }
        // For LV2: the bundle directory is `plugin_path.parent()`, and
        // the LV2 search root is the directory ABOVE that. Record so
        // we can emit a runtime `LV2_PATH` covering non-default host
        // locations like `/home/vscode/.lv2`.
        if matches!(plugin_format.as_str(), "lv2" | "lv2p") {
            if let Some(root) = plugin_path.parent().and_then(|p| p.parent()) {
                let r = root.to_path_buf();
                if !lv2_roots.contains(&r) {
                    lv2_roots.push(r);
                }
            }
        }
    }

    // 4c. Wine layers (if any plugin or the DAW needs Wine).
    if layers.iter().any(|l| l.wine_prefix.is_some())
        || inventory
            .refs
            .iter()
            .any(|r| r.format.eq_ignore_ascii_case("vst"))
    {
        if let Some((wine_layer, wine_deb)) = deps::trace_wine_installation(&mut seen).await? {
            layers.push(wine_layer);
            if let Some(d) = wine_deb {
                deb_deps.push(d);
            }
        }
    }

    // Log unresolved for the operator.
    for u in &unresolved {
        tracing::warn!("UNRESOLVED plugin {} ({}) — {}", u.id, u.format, u.reason);
    }

    // Two env vars Ardour needs to actually boot in a headless
    // container, learned from the production foyer entrypoint
    // (scripts/runtime/entrypoint.sh):
    //
    //   * `ARDOUR_LOVES_STUPID_TINY_SCREENS=1` — Ardour pops a fatal
    //     modal complaining "this screen is not tall enough to display
    //     the editor mixer" on viewports below a hard-coded threshold.
    //     Xvfb's default 1280x1024 sometimes falls below it; nobody can
    //     click "OK" in a container; Ardour hangs forever. The env var
    //     is the escape hatch, set in gtk2_ardour/editor_mixer.cc:91.
    //   * `ARDOUR_BACKEND_PATH` — Ardour's audio-backend search path.
    //     Without it, the Foyer Dummy backend at
    //     `/root/.config/ardour9/backends/libfoyer_audiobackend.so` is
    //     invisible and engine startup falls back to JACK (which the
    //     container doesn't have), then dies.
    let mut runtime_env = vec![
        ("ARDOUR_BACKEND".into(), "None (Dummy)".into()),
        ("ARDOUR_LOVES_STUPID_TINY_SCREENS".into(), "1".into()),
    ];
    // The backend path is `<config-dir>/backends:<dll-dir>/backends`.
    // We only emit the user-config side because that's where we
    // staged the Foyer Dummy backend; the binary side already lives
    // in the standard search.
    if layers.iter().any(|l| l.id == "daw-user-config") {
        let cfg_root = layers
            .iter()
            .find(|l| l.id == "daw-user-config")
            .map(|l| l.dest_root.clone());
        if let Some(root) = cfg_root {
            runtime_env.push((
                "ARDOUR_BACKEND_PATH".into(),
                root.join("backends").display().to_string(),
            ));
        }
    }

    Ok(SnapshotPlan {
        base_image: base,
        project_dir,
        snapshot_name,
        entrypoint,
        layers,
        deb_deps,
        runtime_env,
        unresolved,
        skipped: inventory.skipped,
        lv2_search_roots: lv2_roots,
    })
}

async fn resolve_plugin_paths(
    refs: &[project::PluginRef],
    unresolved: &mut Vec<UnresolvedPlugin>,
) -> Result<Vec<(PathBuf, String)>> {
    let mut out = Vec::new();
    for r in refs {
        match deps::find_plugin_binary(r).await {
            Ok(Some(p)) => out.push((p, r.format.clone())),
            Ok(None) => unresolved.push(UnresolvedPlugin {
                id: r.id.clone(),
                format: r.format.clone(),
                reason: "not found on host filesystem".into(),
            }),
            Err(e) => unresolved.push(UnresolvedPlugin {
                id: r.id.clone(),
                format: r.format.clone(),
                reason: format!("resolution error: {e}"),
            }),
        }
    }
    Ok(out)
}
