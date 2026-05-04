// SPDX-License-Identifier: Apache-2.0
//! Ardour session file introspection.
//!
//! Parses the `.ardour` XML to discover:
//!   - Every `<Processor>` / `<Insert>` reference (LV2, VST2, VST3, LADSPA, etc.)
//!   - External resources (audio files, MIDI files) — copied as part of the
//!     project layer, not as separate dependency layers.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Reference to a plugin discovered inside an Ardour session.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PluginRef {
    /// URI for LV2 / VST3, or label for LADSPA, or DLL basename for VST2.
    pub id: String,
    /// Ardour's type tag: `lv2`, `windows-vst`, `lxvst`, `macvst`, `ladspa`, …
    pub format: String,
    /// Optional explicit path from the session file (rare, but some
    /// wrapped / bridged plugins store it).
    pub explicit_path: Option<PathBuf>,
}

/// Result of extracting plugins from a session — resolved and unresolved.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PluginInventory {
    /// Every unique plugin reference found in the XML.
    pub refs: Vec<PluginRef>,
    /// Plugins whose `type` we didn't recognise (future formats or
    /// internal Ardour processors we should explicitly skip).
    pub skipped: Vec<(String, String)>, // (format, id)
}

/// Find the primary `.ardour` XML inside the session directory.
/// Returns `(snapshot_name, xml_path)`.
pub fn find_main_session_file(project_dir: &Path) -> Result<(String, PathBuf)> {
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(project_dir)
        .with_context(|| format!("read project dir {}", project_dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("ardour"))
        .collect();

    if candidates.is_empty() {
        anyhow::bail!("no *.ardour file found in {}", project_dir.display());
    }
    // Sort so a deterministic name is chosen when multiple snapshots exist.
    candidates.sort();
    let path = candidates.into_iter().next().unwrap();
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("session")
        .to_string();
    Ok((name, path))
}

/// Extract every plugin reference from an Ardour session XML.
pub fn extract_plugin_refs(xml_path: &Path) -> Result<PluginInventory> {
    let text = std::fs::read_to_string(xml_path)
        .with_context(|| format!("read {}", xml_path.display()))?;
    let doc = roxmltree::Document::parse(&text)
        .with_context(|| format!("parse XML {}", xml_path.display()))?;

    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut refs = Vec::new();
    let mut skipped = Vec::new();

    for node in doc.descendants() {
        let tag = node.tag_name().name();
        if tag != "Processor" && tag != "Insert" && tag != "Plugin" {
            continue;
        }

        let Some(format) = node.attribute("type") else {
            continue;
        };
        let format_lc = format.to_lowercase();

        // Skip built-in Ardour processors that are *not* external plugins.
        if is_built_in_processor(&format_lc) {
            continue;
        }

        // The canonical identifier lives on the Processor/Insert tag itself.
        let id = node
            .attribute("unique-id")
            .or_else(|| node.attribute("uri"))
            .or_else(|| node.attribute("id"))
            .or_else(|| node.attribute("label"))
            .unwrap_or("")
            .to_string();

        if id.is_empty() {
            // Some sessions reference a plugin by numeric internal id only
            // (e.g. Ardour's own processors).  If we have a format that
            // looks like an external plugin but no URI/label, note it as
            // skipped so the caller can warn.
            skipped.push((format_lc.clone(), String::new()));
            continue;
        }

        let explicit = node.attribute("path").map(PathBuf::from);

        if !seen.insert((format_lc.clone(), id.clone())) {
            continue;
        }
        refs.push(PluginRef {
            id,
            format: format_lc,
            explicit_path: explicit,
        });
    }

    Ok(PluginInventory { refs, skipped })
}

fn is_built_in_processor(format: &str) -> bool {
    matches!(
        format,
        "audio"
            | "midi"
            | "amp"
            | "polarity"
            | "meter"
            | "main-outs"
            | "trim"
            | "triggerbox"
            | "diskwriter"
            | "diskreader"
            | "meterpeak"
            | "meterk14"
            | "capture"
            | "constant"
            | "io-plugins"
            | "plugin-manager"
            | "plugin-dsp-load"
            | "insert-merge-policy"
    )
}

/// List all audio / MIDI source paths referenced by the session.
/// These are *relative* to `project_dir/interchange/` or absolute.
pub fn external_media_paths(xml_path: &Path) -> Result<Vec<PathBuf>> {
    let text = std::fs::read_to_string(xml_path)
        .with_context(|| format!("read {}", xml_path.display()))?;
    let doc = roxmltree::Document::parse(&text)
        .with_context(|| format!("parse XML {}", xml_path.display()))?;

    let mut paths = Vec::new();
    for node in doc.descendants() {
        if node.tag_name().name() == "Source" {
            if let Some(name) = node.attribute("name") {
                paths.push(PathBuf::from(name));
            }
        }
    }
    Ok(paths)
}
