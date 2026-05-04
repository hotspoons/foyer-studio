// SPDX-License-Identifier: Apache-2.0
//! CLI glue for `foyer snapshot`.
//!
//! This module is intentionally thin — most logic lives in the library
//! layers (`deps`, `oci`, `project`) so it can be tested without a CLI
//! parser in the way.

use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::oci;

/// Arguments coming from `foyer-cli` (or any other CLI front-end).
#[derive(Clone, Debug)]
pub struct SnapshotArgs {
    /// Path to the Ardour session directory.
    pub project_dir: PathBuf,
    /// Optional explicit DAW executable to snapshot instead of auto-detecting.
    pub daw_exec: Option<PathBuf>,
    /// Output directory for the build context / tarball.
    pub out_dir: PathBuf,
    /// OCI tag (e.g. `myproject:latest`).
    pub tag: String,
    /// Build the image with `docker buildx` instead of just emitting files.
    pub build: bool,
    /// Produce a `.tar.gz` loadable with `docker load`.
    pub tarball: bool,
    /// Push to a registry after building.
    pub push: bool,
    /// Registry to push to (e.g. `ghcr.io/user`).
    pub registry: Option<String>,
}

/// Run the snapshot workflow end-to-end.
pub async fn run(args: &SnapshotArgs) -> Result<()> {
    std::fs::create_dir_all(&args.out_dir)
        .with_context(|| format!("create output dir {}", args.out_dir.display()))?;

    let plan = crate::plan(&args.project_dir, args.daw_exec.as_deref())
        .await
        .with_context(|| format!("plan snapshot for {}", args.project_dir.display()))?;

    // Write the plan JSON for debugging / reproducibility.
    let plan_path = args.out_dir.join("snapshot-plan.json");
    let plan_json = serde_json::to_string_pretty(&plan)?;
    tokio::fs::write(&plan_path, plan_json)
        .await
        .with_context(|| format!("write {}", plan_path.display()))?;
    tracing::info!("wrote plan to {}", plan_path.display());

    // Emit Dockerfile + build context.
    let dockerfile = oci::emit_dockerfile(&plan, &args.out_dir)?;
    tracing::info!("wrote Dockerfile to {}", dockerfile.display());

    if args.build {
        oci::build_image(&plan, &args.out_dir, &args.tag).await?;
        tracing::info!("built image {}", args.tag);
    }

    if args.tarball {
        let tar = oci::build_oci_tarball(&plan, &args.out_dir, &args.tag).await?;
        tracing::info!("wrote OCI tarball {}", tar.display());
    }

    if args.push {
        let target = match &args.registry {
            Some(reg) => format!("{}/{}", reg.trim_end_matches('/'), args.tag),
            None => args.tag.clone(),
        };
        push_image(&target).await?;
    }

    Ok(())
}

async fn push_image(tag: &str) -> Result<()> {
    let status = tokio::process::Command::new("docker")
        .args(["push", tag])
        .status()
        .await
        .with_context(|| "spawn docker push")?;
    if !status.success() {
        anyhow::bail!("docker push {tag} failed");
    }
    Ok(())
}
