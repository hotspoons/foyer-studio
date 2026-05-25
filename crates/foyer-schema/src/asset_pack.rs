//! Foreign asset packs — a generic protocol for downloading and
//! serving third-party content (game assets, sample libraries, mods)
//! that Foyer can't ship in the repo for licensing reasons.
//!
//! The server maintains a hardcoded whitelist of allowed sources.
//! Clients ask for a named pack; the server downloads from the
//! whitelisted URL, verifies a sha256 when one's pinned, extracts
//! into `$XDG_DATA_HOME/foyer/asset-packs/<name>/`, and serves the
//! result under the `/asset-packs/<name>/` HTTP route.
//!
//! Wire flow:
//!
//!   1. On greeting, the server emits `AssetPackList` with one
//!      `AssetPackInfo` entry per known pack (state = whatever it
//!      currently is on disk).
//!   2. To start a download, the client sends `FetchAssetPack { name }`.
//!      Anything other than the consent-explicit name lookup is a
//!      no-op; the consent prompt + user click happens in the UI
//!      before this command goes out, so the server doesn't need
//!      its own "are you sure" check.
//!   3. The server emits `AssetPackUpdated` events as the state
//!      transitions: `Downloading` → `Extracting` → `Ready`, with
//!      `progress: 0..=100` filled in during the network phase.
//!      `Failed` carries an error string.

use serde::{Deserialize, Serialize};

/// Lifecycle state of one asset pack on the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetPackState {
    /// Not present locally — known to the whitelist but never
    /// downloaded (or the dir got wiped).
    Available,
    /// HTTP fetch in progress. `progress` should be filled in.
    Downloading,
    /// Bytes received; extracting / verifying.
    Extracting,
    /// Local copy is complete and the HTTP route serves it.
    Ready,
    /// Last attempt failed. `error` carries the reason.
    Failed,
}

/// Snapshot of one asset pack the server knows about. Sent in
/// `Event::AssetPackList` and `Event::AssetPackUpdated`.
///
/// `credits` and `license_note` are surfaced verbatim by the
/// client's consent modal so the user sees exactly what the pack
/// is and where it came from before agreeing to download. The
/// fields are intentionally separate from the URL so the UI can
/// render them on different lines without parsing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetPackInfo {
    /// Stable id used by both protocol + the on-disk directory.
    pub name: String,
    /// Display label for the consent prompt + "downloading X…" toast.
    pub label: String,
    /// URL the server will fetch from. Always part of the
    /// hardcoded whitelist; surfaced so the UI's consent prompt
    /// can show the user exactly which origin they're allowing.
    pub source_url: String,
    /// Free-form attribution string — "© Original Author" — that
    /// the consent modal shows above the OK button.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credits: Option<String>,
    /// Multi-line license/legal note shown next to credits. Foyer
    /// itself doesn't claim any rights over downloaded packs; the
    /// user is downloading directly from the source URL after a
    /// click-through. This field exists so we can be explicit about
    /// that on the UI side too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license_note: Option<String>,
    /// Current state. `Available` / `Ready` are the steady states.
    pub state: AssetPackState,
    /// 0..=100 during the download phase; `None` otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
    /// Last error string when `state == Failed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Total compressed size in bytes, when known from the server's
    /// `content-length` response header. The UI uses this to
    /// translate the running byte total into a percentage if the
    /// server doesn't get a chance to emit explicit progress
    /// events.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
}
