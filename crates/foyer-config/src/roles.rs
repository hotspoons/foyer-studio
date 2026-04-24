//! Role-based access control policy — config-driven, not hardcoded.
//!
//! Ships with a default YAML bundled into the binary
//! (`defaults/roles.yaml`). On first load the file is copied to
//! `$XDG_DATA_HOME/foyer/roles.yaml` for user editing. Callers read the
//! resulting [`RolesConfig`] and call [`RolesConfig::allows`] to gate
//! individual commands.
//!
//! The wire-format "type" tag of each [`foyer_schema::Command`] variant
//! is the canonical id used in `allow` / `deny` patterns. Patterns
//! support exact match, `prefix_*`, `prefix.*`, and the full-trust
//! `*` wildcard. Deny wins over allow.
//!
//! RBAC only applies to tunnel-origin connections. LAN connections skip
//! the check — see `AppState` in `foyer-server` for the origin decision.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

pub const ROLES_FILENAME: &str = "roles.yaml";
pub const ROLES_SCHEMA_VERSION: u32 = 1;

const DEFAULT_ROLES_YAML: &str = include_str!("../defaults/roles.yaml");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RolesConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    pub roles: Vec<RoleDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleDef {
    /// Machine id — matches `TunnelRole` serde names: `admin`,
    /// `session_controller`, `performer`, `viewer`.
    pub id: String,
    /// Human-facing label (used in the invite picker).
    pub label: String,
    /// One-sentence description shown under the role picker.
    pub description: String,
    /// Command patterns the role may invoke. See module docs.
    pub allow: Vec<String>,
    /// Exclusions applied *after* allow. Overrides wildcard allows.
    #[serde(default)]
    pub deny: Vec<String>,
}

fn default_version() -> u32 {
    ROLES_SCHEMA_VERSION
}

impl RolesConfig {
    /// The bundled default, useful as a fallback when the user file is
    /// missing or corrupt.
    pub fn bundled_default() -> Self {
        serde_yaml::from_str(DEFAULT_ROLES_YAML)
            .expect("bundled roles.yaml must parse — if this fires, defaults/roles.yaml is broken")
    }

    /// Returns `true` iff the given role is allowed to invoke the given
    /// command tag. Unknown role ids are denied (fail-closed).
    pub fn allows(&self, role_id: &str, cmd_tag: &str) -> bool {
        let Some(role) = self.roles.iter().find(|r| r.id == role_id) else {
            return false;
        };
        for pat in &role.deny {
            if pattern_matches(pat, cmd_tag) {
                return false;
            }
        }
        for pat in &role.allow {
            if pattern_matches(pat, cmd_tag) {
                return true;
            }
        }
        false
    }

    pub fn role(&self, id: &str) -> Option<&RoleDef> {
        self.roles.iter().find(|r| r.id == id)
    }
}

/// Match a pattern from `allow` / `deny` against a command tag.
///
/// - `*`             — any command
/// - `pfx_*`         — any command with that underscore prefix
/// - `pfx.*`         — any command with that dotted prefix
/// - `exact_name`    — literal
fn pattern_matches(pattern: &str, cmd: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if let Some(prefix) = pattern.strip_suffix(".*") {
        return cmd == prefix || cmd.starts_with(&format!("{prefix}."));
    }
    if let Some(prefix) = pattern.strip_suffix('*') {
        return cmd.starts_with(prefix);
    }
    pattern == cmd
}

// ─── Filesystem ──────────────────────────────────────────────────────

/// Absolute path to the roles config. Co-located with the main
/// `config.yaml` under `$XDG_DATA_HOME/foyer/`.
pub fn roles_path() -> Result<PathBuf> {
    Ok(crate::data_dir()?.join(ROLES_FILENAME))
}

/// Load the user's roles config, seeding the bundled default on first
/// run. Returns the parsed policy ready to query.
pub fn load_or_seed_roles() -> Result<RolesConfig> {
    load_or_seed_roles_at(&roles_path()?)
}

pub fn load_or_seed_roles_at(path: &Path) -> Result<RolesConfig> {
    if path.exists() {
        let raw = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        let cfg: RolesConfig =
            serde_yaml::from_str(&raw).with_context(|| format!("parse {}", path.display()))?;
        return Ok(cfg);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    fs::write(path, DEFAULT_ROLES_YAML)
        .with_context(|| format!("write seed roles to {}", path.display()))?;
    tracing::info!("seeded default roles.yaml at {}", path.display());
    Ok(RolesConfig::bundled_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_default_parses() {
        let cfg = RolesConfig::bundled_default();
        assert!(cfg.role("admin").is_some());
        assert!(cfg.role("session_controller").is_some());
        assert!(cfg.role("performer").is_some());
        assert!(cfg.role("viewer").is_some());
    }

    #[test]
    fn admin_allows_everything() {
        let cfg = RolesConfig::bundled_default();
        assert!(cfg.allows("admin", "add_track"));
        assert!(cfg.allows("admin", "tunnel_create_token"));
        assert!(cfg.allows("admin", "something_that_does_not_exist"));
    }

    #[test]
    fn viewer_cannot_mutate() {
        let cfg = RolesConfig::bundled_default();
        assert!(cfg.allows("viewer", "subscribe"));
        assert!(cfg.allows("viewer", "request_snapshot"));
        assert!(!cfg.allows("viewer", "add_track"));
        assert!(!cfg.allows("viewer", "delete_track"));
        assert!(!cfg.allows("viewer", "tunnel_create_token"));
    }

    #[test]
    fn performer_can_capture_but_not_control_transport() {
        let cfg = RolesConfig::bundled_default();
        assert!(cfg.allows("performer", "audio_ingress_open"));
        assert!(cfg.allows("performer", "audio_stream_open"));
        assert!(!cfg.allows("performer", "control_set")); // no transport
        assert!(!cfg.allows("performer", "save_session"));
    }

    #[test]
    fn session_controller_wildcard_with_denies() {
        let cfg = RolesConfig::bundled_default();
        assert!(cfg.allows("session_controller", "control_set"));
        assert!(cfg.allows("session_controller", "update_track"));
        // denied via deny list
        assert!(!cfg.allows("session_controller", "add_track"));
        assert!(!cfg.allows("session_controller", "delete_track"));
        assert!(!cfg.allows("session_controller", "save_session"));
    }

    #[test]
    fn unknown_role_denied() {
        let cfg = RolesConfig::bundled_default();
        assert!(!cfg.allows("hacker", "subscribe"));
    }

    #[test]
    fn pattern_matching() {
        assert!(pattern_matches("*", "anything"));
        assert!(pattern_matches("track.*", "track.add"));
        assert!(pattern_matches("track.*", "track"));
        assert!(!pattern_matches("track.*", "tracker"));
        assert!(pattern_matches("audio_*", "audio_stream_open"));
        assert!(!pattern_matches("audio_*", "control_set"));
        assert!(pattern_matches("exact", "exact"));
        assert!(!pattern_matches("exact", "exacter"));
    }
}
