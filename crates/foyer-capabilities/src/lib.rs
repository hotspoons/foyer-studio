// SPDX-License-Identifier: Apache-2.0
//! Canonical capability wire ids for Foyer control-plane clients.
//!
//! Add a variant with `#[capability("dotted.id")]` when introducing a user-facing
//! engine feature. The derive emits sorted wire ids for HTTP manifests and diffs.

pub use foyer_capabilities_macros::{cap_decl, CapabilityRegistry};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

/// Single source of truth for capability strings sent in `ClientGreeting.features`
/// and returned from `GET /capabilities`.
#[derive(CapabilityRegistry, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[capability_registry(version = 1)]
pub enum FoyerCapability {
    /// MIDI tracks, piano roll, note editing.
    #[capability("midi")]
    Midi,
    /// Shows, hides, and edits automation lanes on control ids.
    #[capability("automation")]
    Automation,
    /// Route / bus groups (Mixer groups surface).
    #[capability("groups")]
    Groups,
    /// Mixer sends / return routing.
    #[capability("sends")]
    Sends,
    /// Scanning and editing plugin inserts.
    #[capability("plugins")]
    Plugins,
    /// Arm / record-ready semantics and capture-related UX.
    #[capability("recording")]
    Recording,
    /// Export / render / stem workflows (future commands).
    #[capability("export")]
    Export,
    /// Foyer beat-sequencer embedded layout.
    #[capability("sequencer")]
    Sequencer,
    /// Surround panners (Ardour surround paths).
    #[capability("surround_pan")]
    SurroundPan,
    /// Session audio pool listing.
    #[capability("audio.pool.list")]
    AudioPoolList,
    /// Browser / HTTP staging of imports into the pool (`media_import_staging_dir_abs`).
    #[capability("audio.pool.import_http")]
    AudioPoolImportHttp,
    /// Audio region fade in / out (`RegionPatch` fade fields).
    #[capability("region.fade")]
    RegionFade,
    /// Time / rate stretch (MIDI/audio stretch command).
    #[capability("region.stretch")]
    RegionStretch,
    /// Per-region linear gain (`RegionPatch.gain_linear`).
    #[capability("region.gain")]
    RegionGain,
    /// Browser-side Web MIDI bridge (`Command::MidiInput`). Backends
    /// that advertise this accept live MIDI bytes from a connected
    /// browser's MIDI devices and route them onto a virtual source
    /// port (e.g. "Foyer Web MIDI") that DAW tracks can connect to.
    #[capability("midi.web_input")]
    MidiWebInput,
}

/// `GET /capabilities` — static registry + live feature map.
#[derive(Debug, Serialize)]
pub struct CapabilitiesSnapshot {
    pub registry_version: u32,
    pub capabilities: Vec<CapabilityEntry>,
    /// Merged backend + server overlay (e.g. `native_plugin_gui`), same shape as greeting.
    pub active_features: BTreeMap<String, bool>,
}

#[derive(Debug, Serialize)]
pub struct CapabilityEntry {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl CapabilitiesSnapshot {
    #[must_use]
    pub fn build(active_features: BTreeMap<String, bool>) -> Self {
        let mut caps: Vec<CapabilityEntry> = FoyerCapability::ALL
            .iter()
            .map(|c| CapabilityEntry {
                id: c.wire_id().to_string(),
                description: c.description().map(str::to_string),
            })
            .collect();
        caps.sort_by(|a, b| a.id.cmp(&b.id));
        Self {
            registry_version: FoyerCapability::REGISTRY_VERSION,
            capabilities: caps,
            active_features,
        }
    }
}

/// Request body for `POST /capabilities/diff`.
#[derive(Debug, serde::Deserialize)]
pub struct CapabilityDiffRequest {
    /// Client's cached `registry_version` from a prior snapshot (optional).
    #[serde(default)]
    pub registry_version: Option<u32>,
    /// Capability wire ids the client bundle was built against / cares about.
    #[serde(default)]
    pub known_ids: Vec<String>,
}

/// Mismatch report for version upgrades and stale UIs.
#[derive(Debug, Serialize)]
pub struct CapabilityDiffReport {
    pub server_registry_version: u32,
    pub client_registry_version: Option<u32>,
    pub registry_version_mismatch: bool,
    /// Canonical ids added since the client's known set (or entire canonical minus client).
    pub unknown_to_client: Vec<String>,
    /// Ids the client listed that are no longer in the canonical registry.
    pub obsolete_on_client: Vec<String>,
    /// Client listed these; server feature map explicitly has `false`.
    pub disabled_on_server: Vec<String>,
    /// Canonical ids missing from the server's feature map (implicit "unknown" on server).
    pub missing_from_server_map: Vec<String>,
    /// Keys present on the server but not in the canonical enum (overlays, older servers).
    pub server_only_extensions: Vec<String>,
    pub active_features: BTreeMap<String, bool>,
}

#[must_use]
pub fn diff_against_client(
    active_features: BTreeMap<String, bool>,
    req: &CapabilityDiffRequest,
) -> CapabilityDiffReport {
    let server_registry_version = FoyerCapability::REGISTRY_VERSION;
    let client_registry_version = req.registry_version;
    let registry_version_mismatch = matches!(
        client_registry_version,
        Some(v) if v != server_registry_version
    );

    let canonical: BTreeSet<String> = FoyerCapability::WIRE_IDS
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    let client_known: BTreeSet<String> = req.known_ids.iter().cloned().collect();
    let server_keys: BTreeSet<String> = active_features.keys().cloned().collect();

    let unknown_to_client: Vec<String> = (&canonical - &client_known).into_iter().collect();
    let obsolete_on_client: Vec<String> = (&client_known - &canonical).into_iter().collect();

    let mut disabled_on_server = Vec::new();
    for id in &client_known {
        if !canonical.contains(id) {
            continue;
        }
        if let Some(false) = active_features.get(id) {
            disabled_on_server.push(id.clone());
        }
    }
    disabled_on_server.sort();

    let mut missing_from_server_map = Vec::new();
    for id in &canonical {
        if !active_features.contains_key(id) {
            missing_from_server_map.push(id.clone());
        }
    }

    let server_only_extensions: Vec<String> = (&server_keys - &canonical).into_iter().collect();

    CapabilityDiffReport {
        server_registry_version,
        client_registry_version,
        registry_version_mismatch,
        unknown_to_client,
        obsolete_on_client,
        disabled_on_server,
        missing_from_server_map,
        server_only_extensions,
        active_features,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_ids_sorted_unique() {
        let mut prev = "";
        for id in FoyerCapability::WIRE_IDS {
            assert!(id > prev, "unsorted or duplicate: {id} after {prev}");
            prev = id;
        }
    }

    #[test]
    fn diff_flags_version_mismatch() {
        let mut m = BTreeMap::new();
        m.insert("midi".into(), true);
        let req = CapabilityDiffRequest {
            registry_version: Some(0),
            known_ids: vec!["midi".into()],
        };
        let r = diff_against_client(m, &req);
        assert!(r.registry_version_mismatch);
    }
}
