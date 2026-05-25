// Bundled web tree extraction + resolution.
//
// The shipping binary embeds `web/` via `include_dir!`. On first run
// it extracts to `$XDG_DATA_HOME/foyer/web/` so the user can edit
// assets in place; subsequent boots compare a build-time content
// stamp against the extracted copy and re-extract on mismatch.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};

/// Source of the web assets baked into this binary. The path is
/// resolved by `../build.rs` from the `FOYER_BUNDLED_WEB` env var
/// (falling back to the repo's `web/`) and re-exported as a rustc env
/// so `include_dir!` sees the literal path at macro expansion.
static BUNDLED_WEB: include_dir::Dir<'static> = include_dir::include_dir!("$FOYER_BUNDLED_WEB");

/// Content hash of the bundled `web/` tree at build time. Written
/// alongside the extracted assets as `.foyer-bundle-version`; on
/// startup we compare the binary's stamp to the file. A mismatch
/// means the user upgraded the binary — re-extract so they don't
/// stay on yesterday's UI. Computed in `build.rs`.
const BUNDLED_WEB_STAMP: &str = env!("FOYER_BUNDLED_WEB_STAMP");
const BUNDLED_WEB_STAMP_FILE: &str = ".foyer-bundle-version";

/// Resolve the `web_root` the server should serve from.
///
/// Priority (first hit wins):
///   1. `--web-root <path>` on the CLI (explicit override).
///   2. `$XDG_DATA_HOME/foyer/web` — the canonical user-facing path.
///      Extracted from the binary's bundled assets on first boot;
///      edits survive restarts and reinstalls.
///
/// There is deliberately no automatic `./web` fallback: two
/// different working directories shouldn't silently change where
/// Foyer serves from.
pub fn resolve_web_root(explicit: Option<PathBuf>) -> Result<Option<PathBuf>> {
    if let Some(p) = explicit {
        if !p.exists() {
            anyhow::bail!("--web-root {} does not exist", p.display());
        }
        return Ok(Some(p));
    }
    let data_dir = dirs::data_local_dir()
        .ok_or_else(|| anyhow!("cannot resolve $XDG_DATA_HOME"))?
        .join("foyer")
        .join("web");
    let stamp_path = data_dir.join(BUNDLED_WEB_STAMP_FILE);
    let needs_extract = if !data_dir.join("index.html").exists() {
        true
    } else {
        !matches!(
            std::fs::read_to_string(&stamp_path),
            Ok(existing) if existing.trim() == BUNDLED_WEB_STAMP,
        )
    };
    if needs_extract {
        extract_bundled_web(&data_dir)
            .with_context(|| format!("extracting bundled web/ to {}", data_dir.display()))?;
    }
    Ok(Some(data_dir))
}

/// Extract the binary's bundled `web/` to `dst`. Rotates an existing
/// tree to `dst.bak.<old-stamp>` first so user edits aren't silently
/// blown away on upgrade.
fn extract_bundled_web(dst: &Path) -> Result<()> {
    if dst.join("index.html").exists() {
        let old_stamp = std::fs::read_to_string(dst.join(BUNDLED_WEB_STAMP_FILE))
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| "unknown".into());
        let backup = dst.with_file_name(format!(
            "{}.bak.{old_stamp}",
            dst.file_name().and_then(|n| n.to_str()).unwrap_or("web"),
        ));
        if backup.exists() {
            let _ = std::fs::remove_dir_all(&backup);
        }
        std::fs::rename(dst, &backup)
            .with_context(|| format!("rotate {} → {}", dst.display(), backup.display()))?;
        tracing::info!(
            "stale extracted web/ found (stamp {old_stamp}); rotated to {} \
             before re-extracting bundled assets",
            backup.display(),
        );
    }
    std::fs::create_dir_all(dst).with_context(|| format!("mkdir -p {}", dst.display()))?;
    tracing::info!(
        "extracting bundled web/ (stamp {}) to {}",
        BUNDLED_WEB_STAMP,
        dst.display(),
    );
    write_dir_contents(&BUNDLED_WEB, dst)?;
    let _ = std::fs::write(dst.join(BUNDLED_WEB_STAMP_FILE), BUNDLED_WEB_STAMP);
    let readme = dst.join("INSTALLED-HERE.txt");
    let _ = std::fs::write(
        &readme,
        "This directory was seeded from the Foyer binary's bundled web/.\n\
         You can edit anything here — refresh the browser to see changes.\n\
         See HACKING.md for recipes.\n\n\
         When you upgrade the foyer binary, this folder is re-extracted\n\
         from the new bundle. Your previous tree (if any) is rotated\n\
         to ./web.bak.<old-stamp>/ — copy custom edits back from there.\n\n\
         To force a fresh re-extract: delete this folder + the .foyer-\n\
         bundle-version sibling, then restart `foyer serve`.\n",
    );
    Ok(())
}

fn write_dir_contents(dir: &include_dir::Dir<'_>, dst: &Path) -> Result<()> {
    for entry in dir.entries() {
        match entry {
            include_dir::DirEntry::Dir(d) => {
                let sub = dst.join(d.path().file_name().unwrap_or_default());
                std::fs::create_dir_all(&sub)
                    .with_context(|| format!("mkdir -p {}", sub.display()))?;
                write_dir_contents(d, &sub)?;
            }
            include_dir::DirEntry::File(f) => {
                let name = f.path().file_name().unwrap_or_default();
                let out = dst.join(name);
                std::fs::write(&out, f.contents())
                    .with_context(|| format!("write {}", out.display()))?;
            }
        }
    }
    Ok(())
}
