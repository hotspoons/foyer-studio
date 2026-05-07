//! Per-backend filesystem profiles — DAW-specific "how does this
//! backend lay out its projects on disk" rules, separated from the
//! live runtime [`foyer_backend::Backend`] trait.
//!
//! `Backend` is the *runtime* abstraction: subscribe to events, set
//! controls, open audio streams. It assumes a live IPC connection.
//! A `BackendProfile` is the *static* abstraction: which file
//! extensions mark a session, how to spot crash-recovery artifacts on
//! disk, how to sanitize an uploaded project tree, etc. Profiles are
//! consulted at moments when there's no backend connected (the
//! welcome-screen browse, the orphan scan at startup, the upload
//! pipeline) so they can't share the [`Backend`] trait's lifetime.
//!
//! The registry is built once at server startup by the CLI (or
//! whichever entry point owns backend wiring) and stored on
//! [`AppState`]. Filesystem call sites (jail browse, recents,
//! orphans, session-recovery prompts, archive upload) look up the
//! relevant profile by `backend_id` and delegate.
//!
//! Adding a second DAW (Reaper, Bitwig, …) is a matter of writing a
//! new `BackendProfile` impl — the existing `Backend` impl handles
//! the wire — and registering it on the registry. No call site
//! should need to change. If you find yourself string-matching
//! `backend_id == "ardour"` in code, it belongs on this trait.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use foyer_schema::SessionRecoveryArtifact;

use crate::session_recovery;
use crate::session_scrub::{self, ScrubError, ScrubReport};

/// Static, DAW-specific filesystem rules. Consulted at moments when
/// the runtime [`foyer_backend::Backend`] isn't available — startup
/// orphan scan, jail file browser, upload sanitizer, crash-recovery
/// prompt before launch.
///
/// All methods are sync — every call site is already on a synchronous
/// (or `spawn_blocking`-wrapped) filesystem path. Adding async would
/// force trait-object lifetimes through call sites that don't need
/// them.
pub trait BackendProfile: Send + Sync + 'static {
    /// Wire id used in [`foyer_schema::BackendInfo::id`],
    /// `RecentEntry.backend_id`, `OrphanInfo.backend_id`, etc.
    /// Conventionally lowercase, ASCII, no spaces ("ardour", "stub",
    /// "reaper"). The registry is keyed on this.
    fn id(&self) -> &str;

    /// File extensions (without the leading dot) that mark a
    /// directory as a session. The jail browser uses this to flag
    /// folders as `FsEntryKind::SessionDir` and surface the project
    /// name. Empty slice = "this backend has no on-disk session
    /// concept" (e.g. the in-memory stub).
    fn session_file_extensions(&self) -> &[&str] {
        &[]
    }

    /// Probe `project_path` for crash-recovery artifacts the user
    /// would lose if the project opened without intervention. Default
    /// returns empty (no recovery model). Ardour overrides to look
    /// for `.history` / `.pending` / legacy `.bak.<stamp>` siblings.
    fn probe_recovery(&self, _project_path: &Path) -> Vec<SessionRecoveryArtifact> {
        Vec::new()
    }

    /// Sweep recovery artifacts out of the way before launch.
    /// Returns the number of files moved. Default: 0. Backends with
    /// a recovery model implement this to avoid the DAW's native
    /// recovery modal — see Ardour's `.foyer-crash-archive/` sweep.
    fn archive_recovery(&self, _project_path: &Path) -> usize {
        0
    }

    /// Walk a freshly-extracted upload tree and sanitize untrusted
    /// state files (XML scrubbing, kill-list deletion, path
    /// validation). Default: no-op (safe baseline; backends with
    /// known RCE surfaces in their session format must override).
    fn scrub_project(&self, _project_root: &Path) -> Result<ScrubReport, ScrubError> {
        Ok(ScrubReport::default())
    }

    /// Optional MIME hint for an extension this profile recognizes.
    /// Returns `None` to let the generic guesser handle it. Used by
    /// `/files/<path>` to serve project XML as `application/xml` so
    /// browsers render it as text instead of offering download.
    fn mime_for_extension(&self, _ext_lowercase: &str) -> Option<&'static str> {
        None
    }
}

/// In-memory map from `backend_id` → profile. Cheap to clone (every
/// entry is `Arc<dyn BackendProfile>`); shared via `Arc<Self>` on
/// `AppState`.
#[derive(Clone, Default)]
pub struct BackendProfileRegistry {
    profiles: BTreeMap<String, Arc<dyn BackendProfile>>,
    /// Profile id used when a wire payload omits or empties
    /// `backend_id`. Kept separate from the map keys so test fixtures
    /// can build a registry without committing to a "default" pick.
    default_id: Option<String>,
}

impl BackendProfileRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build a registry pre-populated with the profiles foyer ships
    /// with today (Ardour + Stub). The CLI uses this at startup;
    /// downstream embedders (desktop wrapper, integration tests) can
    /// build their own with `BackendProfileRegistry::new()` and
    /// register only what they need.
    pub fn with_builtins() -> Self {
        let mut r = Self::new();
        r.register(Arc::new(ArdourProfile));
        r.register(Arc::new(StubProfile));
        r.set_default("ardour");
        r
    }

    pub fn register(&mut self, profile: Arc<dyn BackendProfile>) {
        let id = profile.id().to_string();
        self.profiles.insert(id, profile);
    }

    /// Mark `id` as the default profile. Lookups with an empty
    /// `backend_id` (legacy registry entries written by old shims)
    /// fall back to this. No-op if `id` isn't registered.
    pub fn set_default(&mut self, id: &str) {
        if self.profiles.contains_key(id) {
            self.default_id = Some(id.to_string());
        }
    }

    pub fn default_id(&self) -> Option<&str> {
        self.default_id.as_deref()
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn BackendProfile>> {
        self.profiles.get(id).cloned()
    }

    /// Look up `id`, falling back to the registry default when `id`
    /// is empty or unknown. Used at hot-path call sites that need a
    /// profile no matter what (jail browse, orphan scan).
    pub fn get_or_default(&self, id: &str) -> Option<Arc<dyn BackendProfile>> {
        if !id.is_empty() {
            if let Some(p) = self.profiles.get(id) {
                return Some(p.clone());
            }
        }
        self.default_id
            .as_deref()
            .and_then(|d| self.profiles.get(d).cloned())
    }

    /// Iterate every registered profile. Useful when the call site
    /// has no `backend_id` to dispatch on (jail browse listing every
    /// folder, recognizing whichever DAW formats happen to be there).
    pub fn iter(&self) -> impl Iterator<Item = &Arc<dyn BackendProfile>> {
        self.profiles.values()
    }

    /// Union of every registered profile's session file extensions.
    /// Stable order — caller can use this in directory walks without
    /// resorting to per-profile dispatch.
    pub fn all_session_extensions(&self) -> Vec<&str> {
        let mut out: Vec<&str> = self
            .profiles
            .values()
            .flat_map(|p| p.session_file_extensions().iter().copied())
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    pub fn is_empty(&self) -> bool {
        self.profiles.is_empty()
    }
}

/// Filesystem profile for the Ardour backend. Delegates to the
/// existing `session_recovery` and `session_scrub` modules — those
/// stay as the canonical implementation; this trait impl makes them
/// reachable through the registry without every call site having to
/// know which DAW it's dealing with.
pub struct ArdourProfile;

impl BackendProfile for ArdourProfile {
    fn id(&self) -> &str {
        "ardour"
    }

    fn session_file_extensions(&self) -> &[&str] {
        // `.ardour` is the project XML extension. The jail uses this
        // to label session folders in the picker.
        const EXT: &[&str] = &["ardour"];
        EXT
    }

    fn probe_recovery(&self, project_path: &Path) -> Vec<SessionRecoveryArtifact> {
        session_recovery::probe(project_path)
    }

    fn archive_recovery(&self, project_path: &Path) -> usize {
        session_recovery::archive(project_path)
    }

    fn scrub_project(&self, project_root: &Path) -> Result<ScrubReport, ScrubError> {
        session_scrub::scrub_project_dir(project_root)
    }

    fn mime_for_extension(&self, ext_lowercase: &str) -> Option<&'static str> {
        if ext_lowercase == "ardour" {
            Some("application/xml; charset=utf-8")
        } else {
            None
        }
    }
}

/// Filesystem profile for the in-memory stub. No on-disk session
/// concept, no recovery, no XML to scrub — every default applies.
pub struct StubProfile;

impl BackendProfile for StubProfile {
    fn id(&self) -> &str {
        "stub"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_with_builtins_has_ardour_and_stub() {
        let r = BackendProfileRegistry::with_builtins();
        assert!(r.get("ardour").is_some());
        assert!(r.get("stub").is_some());
        assert_eq!(r.default_id(), Some("ardour"));
    }

    #[test]
    fn get_or_default_falls_back_when_unknown() {
        let r = BackendProfileRegistry::with_builtins();
        let p = r.get_or_default("reaper").expect("falls back to default");
        assert_eq!(p.id(), "ardour");
    }

    #[test]
    fn get_or_default_falls_back_when_empty() {
        let r = BackendProfileRegistry::with_builtins();
        let p = r.get_or_default("").expect("falls back to default");
        assert_eq!(p.id(), "ardour");
    }

    #[test]
    fn all_session_extensions_includes_ardour() {
        let r = BackendProfileRegistry::with_builtins();
        let exts = r.all_session_extensions();
        assert!(exts.contains(&"ardour"));
    }

    #[test]
    fn empty_registry_returns_none() {
        let r = BackendProfileRegistry::new();
        assert!(r.is_empty());
        assert!(r.get_or_default("ardour").is_none());
    }

    #[test]
    fn set_default_only_accepts_registered_ids() {
        let mut r = BackendProfileRegistry::new();
        r.set_default("ardour");
        assert_eq!(r.default_id(), None);
        r.register(Arc::new(ArdourProfile));
        r.set_default("ardour");
        assert_eq!(r.default_id(), Some("ardour"));
    }

    #[test]
    fn stub_profile_has_no_extensions() {
        let p = StubProfile;
        assert!(p.session_file_extensions().is_empty());
        assert!(p.probe_recovery(Path::new("/nonexistent")).is_empty());
        assert_eq!(p.archive_recovery(Path::new("/nonexistent")), 0);
    }

    #[test]
    fn ardour_profile_finds_recovery_artifacts() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("X.ardour"), b"<a/>").unwrap();
        std::fs::write(dir.path().join("X.history"), b"hh").unwrap();
        let p = ArdourProfile;
        let found = p.probe_recovery(&dir.path().join("X.ardour"));
        assert_eq!(found.len(), 1);
    }
}
