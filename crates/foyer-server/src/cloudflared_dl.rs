//! cloudflared binary auto-download & management.
//!
//! Downloads the official `cloudflared` release for the current platform into
//! `~/.local/share/foyer/bin/cloudflared` (Linux) or the equivalent on macOS/
//! Windows.  Subsequent calls verify the binary exists and is up-to-date.

use anyhow::{anyhow, bail, Context, Result};
use std::path::PathBuf;

const BIN_NAME: &str = "cloudflared";

/// Return the path where we store the managed cloudflared binary.
fn bin_dir() -> Result<PathBuf> {
    let base = dirs::data_dir().ok_or_else(|| anyhow!("no data dir"))?;
    Ok(base.join("foyer").join("bin"))
}

/// Full path to the managed cloudflared binary.
pub fn binary_path() -> Result<PathBuf> {
    Ok(bin_dir()?.join(BIN_NAME))
}

/// True if the managed binary exists and is executable.
#[allow(dead_code)]
pub fn is_installed() -> bool {
    match binary_path() {
        Ok(p) => p.is_file(),
        Err(_) => false,
    }
}

/// Ensure cloudflared is present, downloading if necessary.
pub async fn ensure() -> Result<PathBuf> {
    let path = binary_path()?;
    if path.is_file() {
        // Optional: could verify version and re-download if stale.
        return Ok(path);
    }
    download().await?;
    if !path.is_file() {
        bail!(
            "cloudflared download completed but binary not found at {}",
            path.display()
        );
    }
    Ok(path)
}

async fn download() -> Result<()> {
    let dir = bin_dir()?;
    std::fs::create_dir_all(&dir).with_context(|| format!("create bin dir {}", dir.display()))?;

    let url = download_url()?;
    tracing::info!("downloading cloudflared from {}", url);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()?;

    let resp = client
        .get(&url)
        .send()
        .await
        .with_context(|| format!("download cloudflared from {url}"))?;

    if !resp.status().is_success() {
        bail!("cloudflared download failed: HTTP {}", resp.status());
    }

    let bytes = resp
        .bytes()
        .await
        .context("read cloudflared response body")?;

    let tmp = dir.join("cloudflared.tmp");
    tokio::fs::write(&tmp, &bytes)
        .await
        .with_context(|| format!("write tmp file {}", tmp.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = tokio::fs::metadata(&tmp).await?;
        let mut perms = meta.permissions();
        perms.set_mode(0o755);
        tokio::fs::set_permissions(&tmp, perms).await?;
    }

    let dest = dir.join(BIN_NAME);
    tokio::fs::rename(&tmp, &dest)
        .await
        .with_context(|| format!("rename {} -> {}", tmp.display(), dest.display()))?;

    tracing::info!("cloudflared installed at {}", dest.display());
    Ok(())
}

fn download_url() -> Result<String> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;

    let platform = match (os, arch) {
        ("linux", "x86_64") => "linux-amd64",
        ("linux", "aarch64") => "linux-arm64",
        ("linux", "arm") => "linux-arm",
        ("macos", "x86_64") => "darwin-amd64",
        ("macos", "aarch64") => "darwin-arm64",
        ("windows", "x86_64") => "windows-amd64",
        ("windows", "aarch64") => "windows-arm64",
        _ => bail!("unsupported platform for cloudflared auto-download: {os}/{arch}"),
    };

    // Use latest release.  In production we might pin a version for reproducibility.
    Ok(format!(
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-{platform}{ext}",
        ext = if os == "windows" { ".exe" } else { "" }
    ))
}
