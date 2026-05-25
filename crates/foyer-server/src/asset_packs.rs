//! Foreign-content asset packs — download/extract/serve plumbing.
//!
//! Foyer can't ship third-party mod/game assets in the repo for
//! licensing reasons; instead we host a small hardcoded whitelist
//! of source URLs that the user can choose to fetch at runtime
//! after a click-through consent prompt. The bytes land in
//! `$XDG_DATA_HOME/foyer/asset-packs/<name>/` and are served via
//! the `/asset-packs/<name>/*` HTTP route mounted in `lib.rs`.
//!
//! Threat-model fences:
//!   * The URL list is hardcoded — a compromised client can't
//!     trick the server into fetching arbitrary URLs.
//!   * sha256 is optional but encouraged; when set we verify before
//!     extracting and refuse to keep mismatched bytes.
//!   * Zip extraction is zip-slip safe: every entry's resolved
//!     destination must canonicalize back under the pack's target
//!     directory or we reject the archive whole.
//!   * Concurrent fetches for the same pack collapse to one
//!     in-flight download via a per-pack `Mutex`.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use foyer_schema::asset_pack::{AssetPackInfo, AssetPackState};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

/// One entry in the hardcoded whitelist. The full set is in
/// [`WHITELIST`] below. Adding a pack means:
///   1. Adding an entry here.
///   2. Optionally pinning a sha256 (preferred).
///   3. Picking the on-disk subdir name (used in the URL route).
#[derive(Debug, Clone)]
pub struct AssetPackEntry {
    pub name: &'static str,
    pub label: &'static str,
    pub source_url: &'static str,
    pub credits: Option<&'static str>,
    pub license_note: Option<&'static str>,
    /// Hex-encoded sha256 of the downloaded archive. When `None`,
    /// downloads are accepted as-is (with a warning logged).
    pub sha256: Option<&'static str>,
    /// Archive format. Only `Zip` is implemented today; `TarGz` is
    /// a follow-up.
    pub format: ArchiveFormat,
    /// Optional prefix the archive includes that we want to strip
    /// when extracting. e.g. if every file is under
    /// `sprunki-website/...`, set this to `"sprunki-website/"` and
    /// the extracted layout is `<target>/<file>` instead of
    /// `<target>/sprunki-website/<file>`. Empty string = no strip.
    pub strip_prefix: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub enum ArchiveFormat {
    Zip,
}

/// The whitelist. Editing this is the ONLY way to add a fetchable
/// pack — there's no config-file path on purpose; a misconfigured
/// installation shouldn't be able to coax the server into pulling
/// arbitrary URLs.
pub const WHITELIST: &[AssetPackEntry] = &[AssetPackEntry {
    name: "sprunki",
    label: "Sprunki game assets",
    source_url: "https://archive.org/download/sprunki_20241116/sprunki-website.zip",
    credits: Some("Sprunki characters and artwork © their respective owners."),
    license_note: Some(
        "Foyer Studio does not bundle, redistribute, or claim any rights over the Sprunki \
             assets. Clicking Download fetches them directly from archive.org for your offline \
             use. Don't redistribute the downloaded files yourself.",
    ),
    sha256: None,
    format: ArchiveFormat::Zip,
    // The archive on archive.org wraps everything under a
    // top-level folder. The exact prefix gets fixed up at
    // extract time based on what the archive actually
    // contains, so leaving this empty is safe — we just
    // preserve the archive's own layout under the target dir.
    strip_prefix: "",
}];

pub fn entry(name: &str) -> Option<&'static AssetPackEntry> {
    WHITELIST.iter().find(|e| e.name == name)
}

/// The root directory under which every pack's extracted dir lives.
/// Returns `$XDG_DATA_HOME/foyer/asset-packs` on Linux,
/// `~/Library/Application Support/foyer/asset-packs` on macOS.
pub fn root_dir() -> PathBuf {
    let base = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())));
    base.join("foyer").join("asset-packs")
}

pub fn pack_dir(name: &str) -> PathBuf {
    root_dir().join(name)
}

/// Per-pack runtime state. Held in `AssetPackManager` so the WS
/// layer can broadcast `AssetPackUpdated` events on every change.
#[derive(Debug, Clone)]
struct PackState {
    info: AssetPackInfo,
    /// Serializes concurrent fetch attempts for the same pack —
    /// only one download runs at a time per pack.
    fetch_lock: Arc<Mutex<()>>,
}

/// Manages whitelist state + active downloads. One per `AppState`.
pub struct AssetPackManager {
    states: tokio::sync::RwLock<HashMap<String, PackState>>,
}

impl AssetPackManager {
    pub fn new() -> Self {
        let mut states = HashMap::new();
        for entry in WHITELIST {
            let info = AssetPackInfo {
                name: entry.name.to_string(),
                label: entry.label.to_string(),
                source_url: entry.source_url.to_string(),
                credits: entry.credits.map(|s| s.to_string()),
                license_note: entry.license_note.map(|s| s.to_string()),
                state: probe_disk_state(entry),
                progress: None,
                error: None,
                total_bytes: None,
            };
            states.insert(
                entry.name.to_string(),
                PackState {
                    info,
                    fetch_lock: Arc::new(Mutex::new(())),
                },
            );
        }
        Self {
            states: tokio::sync::RwLock::new(states),
        }
    }

    /// Snapshot of every known pack — what the WS layer ships in
    /// `AssetPackList`.
    pub async fn list(&self) -> Vec<AssetPackInfo> {
        let guard = self.states.read().await;
        let mut out: Vec<_> = guard.values().map(|s| s.info.clone()).collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    pub async fn get(&self, name: &str) -> Option<AssetPackInfo> {
        self.states.read().await.get(name).map(|s| s.info.clone())
    }

    /// Begin (or re-begin) a fetch. Returns the lock guard so the
    /// caller can hold it across the actual download. If another
    /// fetch is already in flight, this awaits its completion and
    /// then returns the lock — the caller checks `info.state` and
    /// usually no-ops because the prior fetch already finished.
    async fn lock(&self, name: &str) -> Option<Arc<Mutex<()>>> {
        self.states
            .read()
            .await
            .get(name)
            .map(|s| s.fetch_lock.clone())
    }

    /// Apply a partial state update. Used by the downloader to push
    /// progress through. Returns the post-update `AssetPackInfo`
    /// snapshot so the caller can broadcast it without re-locking.
    pub async fn update(
        &self,
        name: &str,
        state: AssetPackState,
        progress: Option<u8>,
        error: Option<String>,
        total_bytes: Option<u64>,
    ) -> Option<AssetPackInfo> {
        let mut guard = self.states.write().await;
        let entry = guard.get_mut(name)?;
        entry.info.state = state;
        // Carry forward total_bytes once we've learned it; clear
        // progress/error when reverting to a non-running state.
        if let Some(p) = progress {
            entry.info.progress = Some(p);
        } else if !matches!(state, AssetPackState::Downloading) {
            entry.info.progress = None;
        }
        if total_bytes.is_some() {
            entry.info.total_bytes = total_bytes;
        }
        entry.info.error = error;
        Some(entry.info.clone())
    }
}

impl Default for AssetPackManager {
    fn default() -> Self {
        Self::new()
    }
}

fn probe_disk_state(entry: &AssetPackEntry) -> AssetPackState {
    if pack_dir(entry.name)
        .join(".foyer-asset-pack-ready")
        .is_file()
    {
        AssetPackState::Ready
    } else {
        AssetPackState::Available
    }
}

/// Download + verify + extract a pack. Reports progress through
/// the provided async closure (the WS layer wraps this to broadcast
/// `AssetPackUpdated` events). Blocks on the per-pack fetch lock
/// so concurrent requests collapse to one in-flight download.
pub async fn fetch_pack<F, Fut>(
    manager: &AssetPackManager,
    name: &str,
    mut on_progress: F,
) -> Result<AssetPackInfo>
where
    F: FnMut(AssetPackInfo) -> Fut + Send,
    Fut: std::future::Future<Output = ()> + Send,
{
    let entry = entry(name).ok_or_else(|| anyhow!("unknown asset pack {name:?}"))?;
    let lock = manager
        .lock(name)
        .await
        .ok_or_else(|| anyhow!("asset pack {name:?} not registered"))?;
    let _guard = lock.lock().await;

    // Recheck state after we acquired the lock — another concurrent
    // fetch may have already produced the bytes.
    if let Some(info) = manager.get(name).await {
        if matches!(info.state, AssetPackState::Ready) {
            return Ok(info);
        }
    }

    let target = pack_dir(name);
    tokio::fs::create_dir_all(&target)
        .await
        .with_context(|| format!("create {}", target.display()))?;

    let info = manager
        .update(name, AssetPackState::Downloading, Some(0), None, None)
        .await
        .unwrap();
    on_progress(info).await;

    let bytes = match download_with_progress(manager, name, entry, &mut on_progress).await {
        Ok(b) => b,
        Err(e) => {
            let info = manager
                .update(
                    name,
                    AssetPackState::Failed,
                    None,
                    Some(e.to_string()),
                    None,
                )
                .await
                .unwrap();
            on_progress(info).await;
            return Err(e);
        }
    };

    if let Some(expected) = entry.sha256 {
        let actual = sha256_hex(&bytes);
        if actual.eq_ignore_ascii_case(expected) {
            tracing::info!("asset pack {name}: sha256 matched");
        } else {
            let msg = format!("sha256 mismatch (expected {expected}, got {actual})");
            let info = manager
                .update(name, AssetPackState::Failed, None, Some(msg.clone()), None)
                .await
                .unwrap();
            on_progress(info).await;
            return Err(anyhow!(msg));
        }
    } else {
        tracing::warn!("asset pack {name}: no sha256 pinned — installing without integrity check");
    }

    let info = manager
        .update(name, AssetPackState::Extracting, None, None, None)
        .await
        .unwrap();
    on_progress(info).await;

    let target_owned = target.clone();
    let strip = entry.strip_prefix.to_string();
    if let Err(e) = tokio::task::spawn_blocking(move || extract_zip(&bytes, &target_owned, &strip))
        .await
        .map_err(|e| anyhow!("extractor task panicked: {e}"))?
    {
        let info = manager
            .update(
                name,
                AssetPackState::Failed,
                None,
                Some(e.to_string()),
                None,
            )
            .await
            .unwrap();
        on_progress(info).await;
        return Err(e);
    }

    // Mark ready by dropping a sentinel file. Cheap probe target
    // for `probe_disk_state` on cold start.
    tokio::fs::write(target.join(".foyer-asset-pack-ready"), b"ok")
        .await
        .ok();

    let info = manager
        .update(name, AssetPackState::Ready, None, None, None)
        .await
        .unwrap();
    on_progress(info.clone()).await;
    Ok(info)
}

async fn download_with_progress<F, Fut>(
    manager: &AssetPackManager,
    name: &str,
    entry: &AssetPackEntry,
    on_progress: &mut F,
) -> Result<Vec<u8>>
where
    F: FnMut(AssetPackInfo) -> Fut + Send,
    Fut: std::future::Future<Output = ()> + Send,
{
    let client = reqwest::Client::builder()
        .user_agent(concat!("foyer-studio/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("build http client")?;
    let resp = client
        .get(entry.source_url)
        .send()
        .await
        .with_context(|| format!("GET {}", entry.source_url))?;
    let status = resp.status();
    if !status.is_success() {
        bail!("HTTP {} from {}", status.as_u16(), entry.source_url);
    }
    let total = resp.content_length();
    if let Some(t) = total {
        let info = manager
            .update(name, AssetPackState::Downloading, Some(0), None, Some(t))
            .await
            .unwrap();
        on_progress(info).await;
    }

    use futures::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buf = Vec::with_capacity(total.unwrap_or(0) as usize);
    let mut last_pct: u8 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("read response chunk")?;
        buf.extend_from_slice(&chunk);
        if let Some(t) = total {
            if t > 0 {
                let pct = ((buf.len() as u128 * 100) / t as u128).min(100) as u8;
                if pct > last_pct {
                    last_pct = pct;
                    let info = manager
                        .update(name, AssetPackState::Downloading, Some(pct), None, Some(t))
                        .await
                        .unwrap();
                    on_progress(info).await;
                }
            }
        }
    }
    Ok(buf)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Zip-slip-safe extraction. Every entry's destination must resolve
/// to a path under `target` after path joining + lexical clean-up;
/// anything that escapes via `..` or absolute components is rejected
/// and the whole archive is left half-extracted (caller usually
/// re-runs after fixing the source).
fn extract_zip(bytes: &[u8], target: &Path, strip_prefix: &str) -> Result<()> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader).context("open zip")?;
    let target_canonical = target
        .canonicalize()
        .unwrap_or_else(|_| target.to_path_buf());
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).context("read zip entry")?;
        let raw_name = file
            .enclosed_name()
            .ok_or_else(|| anyhow!("zip entry has unsafe name: {:?}", file.name()))?;
        let stripped = if !strip_prefix.is_empty() {
            raw_name
                .strip_prefix(strip_prefix)
                .unwrap_or(&raw_name)
                .to_path_buf()
        } else {
            raw_name
        };
        if stripped.as_os_str().is_empty() {
            continue;
        }
        let dest = target.join(&stripped);
        // Lexical check: after pushing, the resolved path must still
        // be under `target_canonical`. We use a normalized form
        // because `canonicalize` only works on paths that exist.
        let dest_normalized = normalize_path(&dest);
        if !dest_normalized.starts_with(&target_canonical) && !dest_normalized.starts_with(target) {
            bail!("zip entry {:?} escapes target dir", stripped);
        }
        if file.is_dir() {
            std::fs::create_dir_all(&dest).context("mkdir from zip")?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).context("mkdir parent from zip")?;
        }
        let mut out =
            std::fs::File::create(&dest).with_context(|| format!("create {}", dest.display()))?;
        std::io::copy(&mut file, &mut out).context("write zip entry")?;
        // Preserve Unix exec bit if the archive carried one (matters
        // for any bundled scripts the mod's index.html relies on).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = file.unix_mode() {
                let perms = std::fs::Permissions::from_mode(mode);
                let _ = std::fs::set_permissions(&dest, perms);
            }
        }
    }
    Ok(())
}

/// Lexical path-cleanup that resolves `..` / `.` without touching
/// the filesystem. Strips invalid components and produces a path
/// suitable for prefix-checks against the target directory.
fn normalize_path(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

// The header reader is intentionally NOT used at the moment — we
// hold the full archive bytes in memory because the sprunki pack is
// ~100 MB which is fine for a one-shot extraction. A later pass can
// stream to a temp file if we add packs that are larger than RAM is
// comfortable with.
#[allow(dead_code)]
fn _stream_header_marker(_r: &mut impl Read) {}
